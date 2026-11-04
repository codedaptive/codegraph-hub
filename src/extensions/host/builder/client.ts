/**
 * The server's side of the index builder: the only thing the server (and direct mode) uses to cause an index
 * write. The builder is a child process (./main.ts) that does every cold build, seed, sync and watcher sync
 * of every index, and the codegraph CLI's `init`, `index` and `sync` when a server relays them (./cli-jobs.ts);
 * the server opens databases read-only and asks the builder for the rest through this class.
 *
 * {@link BuilderClient.start} forks the builder with an IPC channel and keeps it running: a builder that
 * exits for any reason but {@link BuilderClient.stop} is started again after a short backoff, and every root
 * this client still holds, or has been told is being built, is sent to it again so the new builder holds it
 * as the old one did. A request while the builder is down waits for the next one (bounded) and then answers
 * as if it had failed: `ensure` answers `none`, `caughtUp` and `release` return, `unfence` and `drain` return, and
 * `sync`, `fence`, `cliIndex` and `cliSync` reject. A request in flight when the builder exits rejects
 * ('the index builder exited'); a rebuild lease does not outlive its builder (its locks name a dead pid).
 *
 * The builder exits once this process goes away (its IPC channel closes): a job already running gets the
 * exit grace to finish first, so the builder does not outlive its server for long.
 */
import { fork, type ChildProcess, type ForkOptions, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalProjectRoot } from '../../../directory';
import { NODE_RUNTIME_FLAGS, WASM_RUNTIME_FLAGS } from '../../../extraction/wasm-runtime-flags';
import { LockUnavailableError } from '../../../errors';
import type { IndexResult, SyncResult } from '../../../extraction';
import type { IndexWriteEvent } from './cli-wire';
import type { FenceKind } from './fences';
import { isReply, type BuilderReply, type BuilderRequest, type BuilderToServer, type CliIndexMode } from './protocol';

export interface BuilderFreshness {
  root: string;                    // canonical root
  watching: boolean;
  degradedReason: string | null;   // what cg.getWatcherDegradedReason-equivalent said, null when fine
  recovering: boolean;             // watcher re-armed, catch-up not finished
  pendingFiles: string[];          // project-relative paths changed but not yet synced
}

export type EnsureOutcome =
  | { kind: 'ready'; root: string }                                   // own complete index, the root to read; the hold's writable open (migrations) was waited for at most a bounded time, so it may still be queued, or the hold could not open it (another live writer, an open failure); the catch-up is queued once it opened
  | { kind: 'seeded'; root: string; source: string; method: 'clone' | 'copy' | 'backup' } // copied from nearest sibling; held as `ready` is (the writable open was waited for at most a bounded time, so it may still be queued); the catch-up is queued once it opened
  | { kind: 'building'; root: string }                                // cold build queued or running (here or by another process)
  | {                                                                 // nothing to serve: nothing to build here / kill switch / unsafe root / failed build / seed failed
      kind: 'none';
      worktree?: string;                                              //   set when the path is in a git worktree a later call may still give an index
      unbuilt?: { root: string; unsafe?: string };                    //   set when the path is a plain directory (no git) whose build root cannot be built: `unsafe` is what the root looks like ("your home directory"), absent when its build failed
    };

/** First wait before a restart, doubled per quick failure up to {@link RESTART_MAX_MS}. */
const RESTART_MIN_MS = 200;
const RESTART_MAX_MS = 5_000;
/** A builder that ran this long before it exited starts the next backoff over from the minimum. */
const STABLE_RUN_MS = 10_000;
/**
 * How long a request waits for a builder that is starting or restarting: one worst-case restart backoff
 * (RESTART_MAX_MS) plus a builder's start-up, so a request that arrives during a restart is served by the
 * new builder rather than failed.
 */
const UP_WAIT_MS = 8_000;
/**
 * Longest an `ensure` waits for its answer once sent. The builder bounds its own waits (a seed behind a cold
 * build answers `building`), so this only catches a wedged builder.
 */
const ENSURE_TIMEOUT_MS = 120_000;
/** How long `stop` waits for the builder to exit after the channel closes. */
const STOP_WAIT_MS = 5_000;
/** Bound on the roots remembered as "being built", so a server that is asked about many worktrees never grows without limit. */
const MAX_BUILDING_ROOTS = 256;

/**
 * The compiled builder entry: beside this file in a build; when the server runs from src/ (the test suite),
 * the copy `npm run build` put in dist/ (the suite's global setup builds it).
 */
export function builderEntry(): string | null {
  const sibling = path.join(__dirname, 'main.js');
  if (fs.existsSync(sibling)) return sibling;
  const built = path.resolve(__dirname, '../../../../dist/extensions/host/builder/main.js');
  return fs.existsSync(built) ? built : null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  /** Receives the `requestEvent` pushes the builder sends for this request (a `cliIndex` or `cliSync`), in order. */
  onEvent?: (event: IndexWriteEvent) => void;
}

/**
 * The error a failed reply stands for: the builder's message kept, a LockUnavailableError rebuilt as such, any
 * other error given the class name the builder sent as its `name` (the CLI's lock-contention test reads it).
 */
function errorOfReply(reply: Extract<BuilderReply, { ok: false }>): Error {
  if (reply.errorName === 'LockUnavailableError') return new LockUnavailableError(reply.error);
  const err = new Error(reply.error);
  if (reply.errorName) err.name = reply.errorName;
  return err;
}

export class BuilderClient {
  private child: ChildProcess | null = null;
  /** The builder has said `ready` and has not exited. */
  private up = false;
  private upWaiters: Array<(up: boolean) => void> = [];
  private stopping = false;
  /** No compiled builder exists to fork: every request answers as failed, and nothing restarts. */
  private unavailable = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private backoffMs = RESTART_MIN_MS;
  private startedAt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private exitWaiters: Array<() => void> = [];
  /** Roots the builder holds for us, by canonical key, with the path to ask for again after a restart. */
  private readonly held = new Map<string, string>();
  /**
   * Roots the builder answered `building` for, by canonical key, with the ask to send again: the call's path
   * and the session anchor it carried (a plain directory is rebuilt at the anchor, not at the call's path).
   * Oldest first.
   */
  private readonly building = new Map<string, { projectPath: string; anchorRoot?: string }>();
  private readonly fresh = new Map<string, BuilderFreshness>();

  private constructor(private readonly opts: { onLog?: (line: string) => void }) {}

  /** Fork the builder now; restart it whenever it exits until stop(). */
  static start(opts: { onLog?: (line: string) => void } = {}): BuilderClient {
    const client = new BuilderClient(opts);
    client.spawn();
    return client;
  }

  /** Resolve projectPath with selectOwnIndexRoot (never an index above a git repository nested around the path); hold an indexed root, else seed or queue a cold build. Resolves once the builder opened
   *  (and migrated) the index, or after a bounded wait (CODEGRAPH_BUILDER_ENSURE_WAIT_MS, default 10 s) when that open is queued behind
   *  a running job, or when the hold could not open it (another live writer, an open failure); the server then opens read-only whatever
   *  is on disk. Never rejects: a dead builder or IPC failure answers { kind: 'none' }.
   *
   *  `anchorRoot` is the calling session's anchor root (src/extensions/host/server/repo-anchor.ts), passed only for
   *  a call that has one. A projectPath outside git with no index is cold-built at that root rather than at the
   *  path itself; with none (no session) the path is the build root. The builder checks the anchor against the
   *  path before it builds anything. */
  async ensure(projectPath: string, anchorRoot?: string): Promise<EnsureOutcome> {
    try {
      const outcome = await this.rpc(
        anchorRoot === undefined ? { op: 'ensure', projectPath } : { op: 'ensure', projectPath, anchorRoot },
        ENSURE_TIMEOUT_MS,
      ) as EnsureOutcome;
      this.record(outcome, projectPath, anchorRoot);
      return outcome;
    } catch (err) {
      this.log(`ensure of ${projectPath} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: 'none' };
    }
  }

  /** Resolves when the root's queued catch-up has run (ok or failed); at once when the root is not held. Never rejects. */
  async caughtUp(root: string): Promise<void> {
    if (!this.held.has(canonicalProjectRoot(root))) return;
    try {
      await this.rpc({ op: 'caughtUp', root });
    } catch {
      /* a dead builder has nothing left to catch up */
    }
  }

  /** The server's sync of a held root: a sync job at sync priority; resolves with its counts when done (the CLI's sync answers the whole result: {@link cliSync}). Rejects on failure (LockUnavailableError message kept). */
  async sync(root: string): Promise<{ filesChanged: number }> {
    const result = await this.rpc({ op: 'sync', root }) as { filesChanged?: unknown };
    return { filesChanged: typeof result?.filesChanged === 'number' ? result.filesChanged : 0 };
  }

  /** The builder said `ready` and has not exited. Answers now: it never waits for a builder that is starting or restarting. */
  isUp(): boolean {
    return this.up && !this.stopping;
  }

  /**
   * Take the rebuild lease of `root` (a `codegraph index` run through the server, or with `kind` `release` a
   * `codegraph uninit`'s fence under which no builder job opens the root): the builder keeps its
   * `rebuild.pid` until {@link unfence}. Rejects with the builder's refusal (message kept, `.name` set from its
   * class name) when a rebuild already holds the root. No timeout.
   */
  async fence(root: string, kind: FenceKind = 'index'): Promise<void> {
    await this.rpc(kind === 'index' ? { op: 'fence', root } : { op: 'fence', root, kind });
  }

  /**
   * Resolves once no job of `root` runs or waits on the builder's queue, one that reads `root` as its seed
   * source included (at once when none does); jobs of other roots are not waited for. Never rejects, and answers
   * at once when the builder is down (it runs no job). Any failure of the request is taken as the builder having
   * exited (the builder's refusal of the root is not told apart from it), and a builder restarted after a
   * `release` fence was taken does not have that fence: a residual of the lease not outliving its builder.
   * No timeout: a running index is waited for. A `release` fence ({@link fence}) taken first keeps new jobs
   * of the root from starting, so this ends.
   */
  async drain(root: string): Promise<void> {
    if (!this.up) return;
    try {
      await this.rpc({ op: 'drain', root });
    } catch {
      /* the builder went away: its jobs went with it */
    }
  }

  /**
   * End the rebuild lease on `root`: resolves once the builder released its locks, after the lease's queued and
   * running jobs settled. Never rejects, and answers at once when the builder is down (its locks went with it).
   * No timeout: a running index is waited for.
   */
  async unfence(root: string): Promise<void> {
    if (!this.up) return;
    try {
      await this.rpc({ op: 'unfence', root });
    } catch {
      /* the builder went away: its locks went with it */
    }
  }

  /**
   * One `init`, `rebuild` (the CLI's `index`), `reindex` or `reindex-leased` of the codegraph CLI as a job on the builder's queue (`mode`: see
   * ./cli-jobs.ts; `rebuild` and `reindex-leased` need the lease of {@link fence}). `onEvent` receives the job's
   * events (`initialized`, `progress`, and with `verbose` the engine's `log` lines) in order, before the result. Rejects with the builder's error (message
   * kept, `.name` set from its class name, a LockUnavailableError rebuilt). No timeout: an index runs for minutes.
   */
  async cliIndex(root: string, mode: CliIndexMode, onEvent: (event: IndexWriteEvent) => void, verbose = false): Promise<IndexResult> {
    return await this.rpc({ op: 'cliIndex', root, mode, ...(verbose ? { verbose } : {}) }, undefined, onEvent) as IndexResult;
  }

  /**
   * One sync of `root` as a job at sync priority; the builder's whole SyncResult. `onEvent` (optional) receives
   * the sync's progress events in order, before the result, as {@link cliIndex}'s does. Rejects like
   * {@link cliIndex}. No timeout.
   */
  async cliSync(root: string, onEvent?: (event: IndexWriteEvent) => void): Promise<SyncResult> {
    return await this.rpc({ op: 'cliSync', root }, undefined, onEvent) as SyncResult;
  }

  /** Drop the hold: stop the watcher, close, release writer.pid. Resolves after, so a CLI can take the slot. Never rejects. */
  async release(root: string): Promise<void> {
    const key = canonicalProjectRoot(root);
    // Forgotten first: a builder that restarts while this request is in flight must not take the root again.
    this.held.delete(key);
    this.building.delete(key);
    this.fresh.delete(key);
    // A builder that is down holds nothing; waiting for its restart would only delay the caller.
    if (!this.up) return;
    try {
      await this.rpc({ op: 'release', root });
    } catch {
      /* the builder went away: its locks went with it */
    } finally {
      // Pushes sent before the builder's reply arrived before it: none of them describes a hold now.
      this.fresh.delete(key);
    }
  }

  /** Last state the builder pushed for root (sync, no IPC). Null when not held. */
  freshness(root: string): BuilderFreshness | null {
    return this.fresh.get(canonicalProjectRoot(root)) ?? null;
  }

  /** The live builder's pid, null while restarting. */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Stop restarting, disconnect, wait for the child's exit (time-boxed). */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.settleUpWaiters(false);
    const child = this.child;
    if (child) {
      const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
      try {
        if (child.connected) child.disconnect();
      } catch {
        /* already closed */
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); }),
      ]);
      clearTimeout(timer);
      // A builder still finishing a job after the grace is its own business: it exits when the job ends, and
      // must not keep this process alive meanwhile.
      if (this.child === child) child.unref();
    }
    this.failPending(new Error('the index builder was stopped'));
  }

  // -------------------------------------------------------------------------
  // The child
  // -------------------------------------------------------------------------

  private spawn(): void {
    if (this.stopping) return;
    const entry = builderEntry();
    if (!entry) {
      this.unavailable = true;
      this.settleUpWaiters(false);
      this.log('no compiled index builder found (dist/extensions/host/builder/main.js); index writes are unavailable');
      return;
    }
    let child: ChildProcess;
    try {
      // stdout is ignored: in direct mode this process's stdout is the MCP protocol. stderr is shared, so the
      // builder's diagnostics land where the server's own do.
      // `fork` hands its options to `spawn`, which honors windowsHide; @types/node lists it only on SpawnOptions,
      // so the type adds it. A server that has no console of its own (a detached one on Windows) must not give the
      // builder a visible one.
      const forkOptions: ForkOptions & Pick<SpawnOptions, 'windowsHide'> = {
        execArgv: [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS],
        env: process.env,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        windowsHide: true,
      };
      child = fork(entry, [], forkOptions);
    } catch (err) {
      this.log(`could not start the index builder: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    child.on('message', (message: BuilderToServer) => this.onMessage(child, message));
    child.on('error', (err) => this.log(`index builder error: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.up = false;
    // Whatever the old builder held is gone with it: its states are stale, and the new one pushes fresh ones.
    this.fresh.clear();
    this.failPending(new Error('the index builder exited'));
    const exitWaiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of exitWaiters) w();
    if (this.stopping) return;
    this.log(`index builder (pid ${child.pid ?? '?'}) exited (${signal ?? `code ${code}`}); restarting`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    if (this.startedAt !== 0 && Date.now() - this.startedAt >= STABLE_RUN_MS) this.backoffMs = RESTART_MIN_MS;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    // The restart is the server's own business; it never keeps a stopping process alive.
    this.restartTimer.unref();
  }

  private onMessage(child: ChildProcess, message: BuilderToServer): void {
    if (this.child !== child || message === null || typeof message !== 'object') return;
    if (isReply(message)) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else request.reject(errorOfReply(message));
      return;
    }
    switch (message.op) {
      case 'requestEvent':
        // Pushed while the request runs: it goes to that request's own callback, none to a request that already answered.
        try {
          this.pending.get(message.requestId)?.onEvent?.(message.event);
        } catch (err) {
          this.log(`an index event handler failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      case 'ready':
        this.up = true;
        this.settleUpWaiters(true);
        this.resendRoots();
        return;
      case 'freshness':
        // The first push for a root arrives before the `ensure` reply that makes it held, so it is kept
        // whatever `held` says; `release` drops what its own request let through.
        this.fresh.set(canonicalProjectRoot(message.state.root), message.state);
        return;
      case 'released': {
        const key = canonicalProjectRoot(message.root);
        this.held.delete(key);
        this.fresh.delete(key);
        return;
      }
    }
  }

  /** A new builder is up: hold again every root the old one held, and queue again every build it was asked for. */
  private resendRoots(): void {
    const asks: Array<{ key: string; projectPath: string; anchorRoot?: string }> = [
      ...[...this.held.entries()].map(([key, projectPath]) => ({ key, projectPath })),
      ...[...this.building.entries()].map(([key, ask]) => ({ key, ...ask })),
    ];
    for (const { key, projectPath, anchorRoot } of asks) {
      this.building.delete(key);
      void this.ensure(projectPath, anchorRoot);
    }
  }

  private settleUpWaiters(up: boolean): void {
    const waiters = this.upWaiters;
    this.upWaiters = [];
    for (const w of waiters) w(up);
  }

  private failPending(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(err);
  }

  /** Resolves true once the builder is ready, false when it is not coming (stopped, no entry) or `ms` passed. */
  private whenUp(ms: number): Promise<boolean> {
    if (this.up) return Promise.resolve(true);
    if (this.stopping || this.unavailable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const at = this.upWaiters.indexOf(waiter);
        if (at >= 0) this.upWaiters.splice(at, 1);
        resolve(false);
      }, ms);
      const waiter = (up: boolean) => { clearTimeout(timer); resolve(up); };
      this.upWaiters.push(waiter);
    });
  }

  /**
   * One request and its one reply. `timeoutMs` (absent: none) bounds the wait for the reply. `onEvent` receives
   * the `requestEvent` pushes the builder sends for this request until it answers.
   */
  private async rpc(request: DistributiveOmit<BuilderRequest, 'id'>, timeoutMs?: number, onEvent?: (event: IndexWriteEvent) => void): Promise<unknown> {
    if (!(await this.whenUp(UP_WAIT_MS))) throw new Error('the index builder is not running');
    const child = this.child;
    if (!child) throw new Error('the index builder is not running');
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done: PendingRequest = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        ...(onEvent ? { onEvent } : {}),
      };
      this.pending.set(id, done);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`the index builder did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      try {
        child.send({ id, ...request }, (err) => {
          if (err && this.pending.delete(id)) done.reject(err);
        });
      } catch (err) {
        this.pending.delete(id);
        done.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Remember what an `ensure` answered, so a restarted builder is told the same. */
  private record(outcome: EnsureOutcome, projectPath: string, anchorRoot: string | undefined): void {
    if (this.stopping) return;
    if (outcome.kind === 'ready' || outcome.kind === 'seeded') {
      const key = canonicalProjectRoot(outcome.root);
      this.held.set(key, outcome.root);
      this.building.delete(key);
    } else if (outcome.kind === 'building') {
      const key = canonicalProjectRoot(outcome.root);
      this.building.delete(key); // re-inserted last: the oldest is the one dropped past the bound
      this.building.set(key, anchorRoot === undefined ? { projectPath } : { projectPath, anchorRoot });
      if (this.building.size > MAX_BUILDING_ROOTS) {
        const oldest = this.building.keys().next().value;
        if (oldest !== undefined) this.building.delete(oldest);
      }
    }
  }

  private log(line: string): void {
    const text = `[CodeGraph MCP] ${line}`;
    if (this.opts.onLog) this.opts.onLog(text);
    else process.stderr.write(`${text}\n`);
  }
}

/** `Omit` applied to each member of a union, so a request without its id keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
