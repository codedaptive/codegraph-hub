/**
 * The CLI side of an index write that runs in the machine server's index builder instead of in the CLI's own
 * process: `codegraph init`, `index` and `sync`, and the `--fresh` wait of the answering commands; and of the
 * release `codegraph uninit` needs before it deletes an index (the server and the builder let go of the root,
 * and the CLI deletes it under the lease). The wire is
 * ./cli-wire.ts; the server's relay is ./cli-relay.ts and the builder's jobs are ./cli-jobs.ts.
 *
 * One decision point, {@link builderRoute}: a running machine server (src/mcp/server-control.ts probeServer)
 * gives a {@link BuilderRoute}, one connection to the server's existing socket; anything else gives null and the
 * command writes in its own process. builder.pid is not consulted: a direct-mode builder
 * writes the same file for its own state dir and a stale one proves nothing, so only a server that proved
 * itself by its socket hello counts, and that server's own client then decides whether its builder is up (a
 * `{routed: false}` answer).
 *
 * Nothing here creates a file or a directory, starts a process, or waits on a timer once connected: an index
 * runs for minutes.
 *
 * Loaded only with `await import`, by the commands' hook-ins in src/bin/codegraph.ts and
 * ../fresh/cli.ts, so registering a command never loads this module or the engine.
 *
 * The three `start...`/`open...` functions below wrap a route in the object the command already drives (an
 * {@link IndexWriter} where it called CodeGraph.init / recreate, a {@link SyncWriter} where it called
 * CodeGraph.open), so each command keeps its own output code and runs it on either.
 */
import * as net from 'net';
import type { CodeGraph } from '../../../index';
import type { IndexProgress, IndexResult, SyncResult } from '../../../extraction';
import type { ServerLockInfo } from '../../../mcp/daemon-paths';
import { controlClientHelloLine, isServerHello, probeServer } from '../../../mcp/server-control';
import {
  INDEX_WRITE_END_METHOD,
  INDEX_WRITE_EVENT_METHOD,
  INDEX_WRITE_METHOD,
  type IndexWriteErrorData,
  type IndexWriteEvent,
  type IndexWriteParams,
  type IndexWriteResult,
  type ReleaseResult,
} from './cli-wire';

/** What a request answers: the builder's result, or that nothing was taken or queued (the CLI writes itself). */
export type RouteAnswer<R> = { routed: true; result: R } | { routed: false; reason: string };

/** Receives a running init / index / reindex request's events, in order. */
export type RouteEventHandler = (event: IndexWriteEvent) => void;

/**
 * One connection to the machine server, for the requests of one command. Requests are serialized: a second
 * one waits for the first's reply, so an event always belongs to the request in flight.
 *
 * Each request answers a {@link RouteAnswer}, or throws:
 *   - the server's JSON-RPC error: `Error(message)` named by the error's `data.errorName` when it has one,
 *     so a LockUnavailableError is still matched by name (checkpoint.ts);
 *   - the connection lost after the request was sent: the write may have run or still be running, so the
 *     command fails rather than writing the index itself.
 * `{routed: false}` is answered only when nothing was sent or the server's index builder is not up, so the command may write in its own process.
 */
export interface BuilderRoute {
  /**
   * `init`: CodeGraph.init then indexAll in the builder; an `initialized` event comes between them. With
   * `verbose` (the CLI's --verbose, here and on `index` and `reindex`) the builder runs indexAll verbose and
   * sends the engine's console.log lines as `log` events.
   */
  init(root: string, force: boolean, onEvent?: RouteEventHandler, verbose?: boolean): Promise<RouteAnswer<IndexResult>>;
  /** `index`: takes the lease on `root` (it stays until {@link end} or the connection goes), recreates, indexes. */
  index(root: string, force: boolean, onEvent?: RouteEventHandler, verbose?: boolean): Promise<RouteAnswer<IndexResult>>;
  /** `reindex`: indexAll again, under this connection's lease on `root` when `index` took one. */
  reindex(root: string, onEvent?: RouteEventHandler, verbose?: boolean): Promise<RouteAnswer<IndexResult>>;
  /** `sync`: one sync of `root`, a sync job on the builder. The events are the sync's progress, if the server sends any. */
  sync(root: string, onEvent?: RouteEventHandler): Promise<RouteAnswer<SyncResult>>;
  /**
   * `release`: the uninit's request. Fences `root` with a `release` fence (`rebuild.pid` only; the builder starts no job that
   * opens it while the lease stands), has the server and the builder let go of its index, and answers once no builder job
   * of the root runs or waits; nothing is rebuilt. The lease stays until {@link end} or the
   * connection goes, so the caller deletes `.codegraph` and then ends it.
   */
  release(root: string): Promise<RouteAnswer<ReleaseResult>>;
  /**
   * Ends the lease `index` or `release` took and answers once the server and builder have released it, so the root's lock
   * files are gone when the command exits. Never rejects: a connection already gone has already lost the lease.
   * The request queues behind one in flight, so a caller that is failing while its `index` request still runs
   * uses {@link close} instead (see RoutedWriter.end).
   */
  end(root: string): Promise<void>;
  /** Drops the connection. A lease not ended is released by the server, asynchronously. Idempotent. */
  close(): void;
}

/**
 * Reading the server hello. The server writes it as soon as the socket accepts, so 5 s is ample even on a
 * loaded machine; silence longer than that means this is not a live CodeGraph server.
 */
const HELLO_TIMEOUT_MS = 5_000;

const CONNECTION_LOST = 'the CodeGraph server closed the connection before the index write finished';

/** The one request in flight on a connection. */
interface Pending {
  id: number;
  onEvent: RouteEventHandler | undefined;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** What {@link RouteConnection.rpc} saw: the request was never sent, or the server's result. */
type RpcOutcome = { sent: false } | { sent: true; result: unknown };

/** The route over one socket to `lock`'s server. */
class RouteConnection implements BuilderRoute {
  private buffer = '';
  private greeted = false;
  private closed = false;
  private nextId = 1;
  private pending: Pending | null = null;
  /** The tail of the request chain: the next request starts when this settles. */
  private tail: Promise<unknown> = Promise.resolve();
  private helloSettled: ((ok: boolean) => void) | null = null;

  private constructor(
    private readonly socket: net.Socket,
    private readonly lock: ServerLockInfo,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(String(chunk)));
    socket.on('error', () => this.onClosed());
    socket.on('close', () => this.onClosed());
  }

  /** Connect and read the hello: null when the socket does not answer, or answers as another server than `lock`'s. */
  static open(lock: ServerLockInfo): Promise<RouteConnection | null> {
    return new Promise((resolve) => {
      let connection: RouteConnection;
      try {
        connection = new RouteConnection(net.createConnection(lock.socketPath), lock);
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => connection.close(), HELLO_TIMEOUT_MS);
      timer.unref?.();
      connection.helloSettled = (ok) => {
        clearTimeout(timer);
        connection.helloSettled = null;
        if (!ok) connection.close();
        resolve(ok ? connection : null);
      };
    });
  }

  init(root: string, force: boolean, onEvent?: RouteEventHandler, verbose = false): Promise<RouteAnswer<IndexResult>> {
    return this.indexWrite({ op: 'init', root, force, ...(verbose ? { verbose } : {}) }, onEvent) as Promise<RouteAnswer<IndexResult>>;
  }

  index(root: string, force: boolean, onEvent?: RouteEventHandler, verbose = false): Promise<RouteAnswer<IndexResult>> {
    return this.indexWrite({ op: 'index', root, force, ...(verbose ? { verbose } : {}) }, onEvent) as Promise<RouteAnswer<IndexResult>>;
  }

  reindex(root: string, onEvent?: RouteEventHandler, verbose = false): Promise<RouteAnswer<IndexResult>> {
    return this.indexWrite({ op: 'reindex', root, ...(verbose ? { verbose } : {}) }, onEvent) as Promise<RouteAnswer<IndexResult>>;
  }

  sync(root: string, onEvent?: RouteEventHandler): Promise<RouteAnswer<SyncResult>> {
    return this.indexWrite({ op: 'sync', root }, onEvent) as Promise<RouteAnswer<SyncResult>>;
  }

  release(root: string): Promise<RouteAnswer<ReleaseResult>> {
    return this.indexWrite({ op: 'release', root }) as Promise<RouteAnswer<ReleaseResult>>;
  }

  async end(root: string): Promise<void> {
    try {
      await this.rpc(INDEX_WRITE_END_METHOD, { root });
    } catch {
      /* the connection is gone, and the server released the lease with it */
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private async indexWrite(
    params: IndexWriteParams,
    onEvent?: RouteEventHandler,
  ): Promise<RouteAnswer<IndexResult | SyncResult | ReleaseResult>> {
    const outcome = await this.rpc(INDEX_WRITE_METHOD, params, onEvent);
    if (!outcome.sent) return { routed: false, reason: 'the connection to the CodeGraph server is closed' };
    const reply = outcome.result as Partial<IndexWriteResult> | null;
    if (reply && reply.routed === false) {
      return { routed: false, reason: typeof reply.reason === 'string' ? reply.reason : 'the server did not route the write' };
    }
    if (reply && reply.routed === true && reply.result !== undefined) return { routed: true, result: reply.result };
    throw new Error('the CodeGraph server answered an index write with a reply this CLI does not understand');
  }

  /** One request, after the earlier ones' replies. A rejection of an earlier one does not stop this one. */
  private rpc(method: string, params: object, onEvent?: RouteEventHandler): Promise<RpcOutcome> {
    const run = this.tail.then(() => this.send(method, params, onEvent));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private send(method: string, params: object, onEvent: RouteEventHandler | undefined): Promise<RpcOutcome> {
    if (this.closed) return Promise.resolve({ sent: false });
    const id = this.nextId++;
    return new Promise<RpcOutcome>((resolve, reject) => {
      this.pending = {
        id,
        onEvent,
        resolve: (result) => resolve({ sent: true, result }),
        reject,
      };
      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Not our server's protocol. Dropping the connection fails the request in flight, if there is one.
        this.close();
        return;
      }
      if (!this.greeted) {
        this.greet(message);
        if (!this.greeted) return;
        continue;
      }
      this.dispatch(message);
    }
  }

  /** The first line is the hello of the server `lock` names (its pid and version), else this is not that server. */
  private greet(message: Record<string, unknown>): void {
    const ok = isServerHello(message) && message.pid === this.lock.pid && message.codegraph === this.lock.version;
    if (ok) {
      this.greeted = true;
      this.socket.write(controlClientHelloLine());
    }
    this.helloSettled?.(ok);
  }

  private dispatch(message: Record<string, unknown>): void {
    const pending = this.pending;
    if (pending === null) return;
    if (message.method === INDEX_WRITE_EVENT_METHOD) {
      const event = (message.params as { event?: IndexWriteEvent } | undefined)?.event;
      if (event === undefined) return;
      try {
        pending.onEvent?.(event);
      } catch {
        // A progress renderer's failure is cosmetic; the write it describes goes on.
      }
      return;
    }
    if (message.id !== pending.id) return;
    this.pending = null;
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { message?: unknown; data?: IndexWriteErrorData };
      const failure = new Error(typeof error.message === 'string' ? error.message : 'the CodeGraph server refused the request');
      if (typeof error.data?.errorName === 'string') failure.name = error.data.errorName;
      pending.reject(failure);
      return;
    }
    pending.resolve(message.result);
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.helloSettled?.(false);
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(CONNECTION_LOST));
  }
}

/**
 * The route to this state dir's machine server, or null when none is running: the server of
 * `<state>/server.pid` must be a live process whose socket hello names that pid and version. Never throws (an
 * invalid CODEGRAPH_STATE_DIR is "not running"), creates nothing and starts nothing.
 */
export async function builderRoute(): Promise<BuilderRoute | null> {
  try {
    const lock = await probeServer();
    if (lock === null) return null;
    return await RouteConnection.open(lock);
  } catch {
    return null;
  }
}

/**
 * Delivers a running write's events in the order they arrived: progress to the listener that is attached,
 * and the engine's `log` lines (a verbose request's) to stdout with console.log, as an in-process index
 * prints them between its progress lines. Holds both kinds that arrive before a listener is attached, so
 * nothing prints ahead of the command's own output that precedes `indexAll`.
 */
class EventSink {
  private listener: ((progress: IndexProgress) => void) | null = null;
  private queued: IndexWriteEvent[] = [];

  push(event: IndexWriteEvent): void {
    if (event.kind === 'initialized') return;
    if (this.listener) this.deliver(event, this.listener);
    else this.queued.push(event);
  }

  /** Replays what was held, in order, then delivers live. */
  attach(listener: (progress: IndexProgress) => void): void {
    this.listener = listener;
    const held = this.queued;
    this.queued = [];
    for (const event of held) this.deliver(event, listener);
  }

  private deliver(event: IndexWriteEvent, listener: (progress: IndexProgress) => void): void {
    if (event.kind === 'progress') listener(event.progress);
    else if (event.kind === 'log') console.log(event.line);
  }
}

/**
 * What `init` and `index` drive in place of the writable CodeGraph they open in their own process: the calls
 * they make on it afterwards (indexAll, the telemetry's getStats / getBackend, destroy).
 */
export type IndexWriter = Pick<CodeGraph, 'indexAll' | 'getStats' | 'getBackend' | 'destroy'>;

/** An {@link IndexWriter} whose index is written by the builder. `end()` is for `index`, which holds a lease. */
export interface RoutedIndexWriter extends IndexWriter {
  /**
   * Ends the lease and drops the connection, answering once the root's lock files are released. Never rejects.
   * When the lease's `index` request is still in flight (the command is failing before its first `indexAll`
   * took the answer), it does not queue the end behind the rebuild, which would hold the exit until the
   * rebuild finished: it drops the connection, and the server releases the lease when the connection goes
   * (the builder's unfence waits for the running job), so the lock files go after this resolves.
   */
  end(): Promise<void>;
}

/**
 * The writer of an `init` or `index` request that has been sent. The first `indexAll` answers that request
 * (its progress goes to the `onProgress` it is given, the events that came earlier replayed first); each later
 * one is a `reindex` on the same connection, under the lease when `index` took one.
 */
class RoutedWriter implements RoutedIndexWriter {
  private first: Promise<RouteAnswer<IndexResult>> | null;
  /** The first request has not answered yet; see {@link end}. */
  private firstInFlight = true;
  private statsSource: CodeGraph | null = null;
  private ended = false;

  constructor(
    private readonly route: BuilderRoute,
    private readonly root: string,
    first: Promise<RouteAnswer<IndexResult>>,
    private readonly sink: EventSink,
    private readonly holdsLease: boolean,
  ) {
    this.first = first;
    const answered = (): void => { this.firstInFlight = false; };
    first.then(answered, answered);
  }

  async indexAll(options?: Parameters<CodeGraph['indexAll']>[0]): Promise<IndexResult> {
    this.sink.attach(options?.onProgress ?? (() => undefined));
    let answer: RouteAnswer<IndexResult>;
    if (this.first !== null) {
      answer = await this.first;
      this.first = null;
    } else {
      answer = await this.route.reindex(this.root, (event) => this.sink.push(event), options?.verbose === true);
    }
    if (!answer.routed) {
      throw new Error(`the CodeGraph server's index builder is not available: ${answer.reason}`);
    }
    await this.openStatsSource();
    return answer.result;
  }

  /** The telemetry reads the finished index's stats; the builder wrote it, so this process opens it read-only. */
  private async openStatsSource(): Promise<void> {
    if (this.statsSource !== null) return;
    const { default: CodeGraph } = await import('../../../index');
    this.statsSource = await CodeGraph.open(this.root, { readOnly: true });
  }

  getStats(): ReturnType<CodeGraph['getStats']> {
    if (this.statsSource === null) throw new Error('the index was not written yet');
    return this.statsSource.getStats();
  }

  getBackend(): ReturnType<CodeGraph['getBackend']> {
    if (this.statsSource === null) throw new Error('the index was not written yet');
    return this.statsSource.getBackend();
  }

  /** Closes the read-only instance, and the connection unless a lease still has to be ended by {@link end}. */
  destroy(): void {
    this.statsSource?.destroy();
    this.statsSource = null;
    if (!this.holdsLease) this.route.close();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.destroy();
    // A queued `end` would wait for the running `index` request, that is the whole rebuild. With the first
    // request unanswered and never taken by indexAll, the command is failing: drop the connection and let the
    // server's release of the lease (connection closed -> unfence) do the ending.
    const abandoned = this.first !== null && this.firstInFlight;
    if (this.holdsLease && !abandoned) await this.route.end(this.root);
    this.route.close();
  }
}

/**
 * Start `codegraph init` of `root` in the builder. Null when nothing routes (no server, or its builder is
 * not up): the caller runs CodeGraph.init itself. Otherwise resolves once the builder has run CodeGraph.init,
 * the point where the in-process command's CodeGraph.init returns, with a writer whose first `indexAll` answers
 * the rest of the request. Rejects with what CodeGraph.init would have thrown (the server's refusals and the
 * builder's errors arrive as thrown errors). `verbose`: the command's --verbose, so the builder runs indexAll
 * verbose and the engine's lines print here as the in-process run prints them.
 */
export async function startRoutedInit(root: string, force: boolean, verbose: boolean): Promise<RoutedIndexWriter | null> {
  return startRoutedWrite(root, false, (route, onEvent) => route.init(root, force, onEvent, verbose), 'initialized');
}

/**
 * Start `codegraph index` of `root` in the builder, which takes the lease on the root, recreates the index
 * and indexes it. Null when nothing routes: the caller takes `rebuild.pid` and the rest itself. Otherwise
 * resolves once the builder has begun (its first progress event), the point where the in-process command's
 * CodeGraph.recreate returns, so a refusal (another rebuild running, a lock held) rejects here as it
 * rejects there. The caller calls `end()` when the command is over. `verbose` as for {@link startRoutedInit};
 * pass it false when the command indexes quietly.
 */
export async function startRoutedIndex(root: string, force: boolean, verbose: boolean): Promise<RoutedIndexWriter | null> {
  return startRoutedWrite(root, true, (route, onEvent) => route.index(root, force, onEvent, verbose), 'progress');
}

async function startRoutedWrite(
  root: string,
  holdsLease: boolean,
  request: (route: BuilderRoute, onEvent: RouteEventHandler) => Promise<RouteAnswer<IndexResult>>,
  startedBy: IndexWriteEvent['kind'],
): Promise<RoutedIndexWriter | null> {
  const route = await builderRoute();
  if (route === null) return null;

  const sink = new EventSink();
  let started: () => void = () => undefined;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const answer = request(route, (event) => {
    if (event.kind === startedBy) started();
    sink.push(event);
  });

  // Whichever comes first: the request's first sign of life, or its end (a refusal, or `routed: false`).
  const ended: { answer?: RouteAnswer<IndexResult>; error?: unknown; failed?: boolean } = {};
  const settle = answer.then(
    (value) => { ended.answer = value; },
    (error: unknown) => { ended.failed = true; ended.error = error; },
  );
  await Promise.race([startedP, settle]);

  if (ended.failed) {
    route.close();
    throw ended.error;
  }
  if (ended.answer !== undefined && !ended.answer.routed) {
    route.close();
    return null;
  }
  return new RoutedWriter(route, root, answer, sink, holdsLease);
}

/**
 * What `sync` and the `--fresh` wait drive in place of a writable CodeGraph: sync and destroy, and
 * `isIndexStale` (whether the index was built by an older extraction engine), which `codegraph sync` reports
 * after it runs. A CodeGraph answers it at once; a routed sync has no index open, so it reads the stamp.
 */
export type SyncWriter = Pick<CodeGraph, 'sync' | 'destroy'> & {
  isIndexStale(): boolean | Promise<boolean>;
};

/**
 * A {@link SyncWriter} that runs each sync as a sync job on the builder, with the sync's progress events
 * (when the server sends them) fed to the `onProgress` it is given. Should the server answer that its builder
 * is not up (nothing queued), that one sync runs in this process on a writable instance, as without a route.
 */
class RoutedSync implements SyncWriter {
  constructor(
    private readonly route: BuilderRoute,
    private readonly root: string,
  ) {}

  async sync(options?: Parameters<CodeGraph['sync']>[0]): Promise<SyncResult> {
    const onProgress = options?.onProgress;
    const answer = await this.route.sync(this.root, (event) => {
      if (event.kind === 'progress') onProgress?.(event.progress);
    });
    if (answer.routed) return answer.result;
    const { default: CodeGraph } = await import('../../../index');
    const writable = await CodeGraph.open(this.root);
    try {
      return await writable.sync(options);
    } finally {
      writable.destroy();
    }
  }

  /**
   * The sync ran on the builder, so this process holds no index: the stamp is read through a short
   * read-only handle (it writes nothing and starts no watcher).
   */
  async isIndexStale(): Promise<boolean> {
    const { default: CodeGraph } = await import('../../../index');
    const reader = CodeGraph.openSync(this.root, { readOnly: true });
    try {
      return reader.isIndexStale();
    } finally {
      reader.close();
    }
  }

  destroy(): void {
    this.route.close();
  }
}

/** The syncing side of `root` through the builder, or null when nothing is running to route to. */
export async function openRoutedSync(root: string): Promise<SyncWriter | null> {
  const route = await builderRoute();
  return route === null ? null : new RoutedSync(route, root);
}
