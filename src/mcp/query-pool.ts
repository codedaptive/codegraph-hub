/**
 * Query pool — runs CPU-heavy read-tool calls on a pool of worker threads so
 * the shared daemon's main event loop stays free for the MCP transport.
 *
 * Why this exists: see {@link ./query-worker}. One daemon, one event loop, one
 * synchronous SQLite connection serializes every concurrent `codegraph_explore`
 * AND starves the transport (a 10-way wave delivered 0 transport heartbeats in
 * 25s — responses can't flush until the whole batch drains, so clients time
 * out). Spreading the dispatch across worker threads (each its own WAL read
 * connection) restores true multi-core parallelism and an idle main loop.
 *
 * Properties:
 *   - lazy growth: one warm worker on construct, grows to `size` on demand, so a
 *     single-agent session pays for one connection and a 10-subagent burst grows
 *     to the core budget.
 *   - idle retirement: a worker idle for `idleTimeoutMs` (default 60s,
 *     `CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS`, `0` = never) is retired, oldest
 *     idle first, down to a floor of one started worker (a worker still
 *     starting does not count toward the floor). The worker that served last
 *     is the one kept: it is retired only after the other idle workers, which
 *     served earlier or not at all. Retiring is a handshake: the worker closes its
 *     connections and exits 0. It is not a crash, so it is never respawned and
 *     never counts toward the crash budget.
 *   - idle trim: the one worker the retirement leaves gives its memory back too,
 *     once it has been idle for `idleShrinkMs` (default 5 min, `0` = never; its
 *     own clock) and has served since its
 *     last trim. A pool still above the floor is not trimmed: it retires
 *     first. The worker is not stopped: it stays up and shrinks in place
 *     (`trim`: it closes every project but the last one used, and its connections give up their
 *     page cache and file mapping), so the next call finds a warm worker, its
 *     compiled code and the memos of its connection, rather than a cold start.
 *     It answers `trimmed` with what it still holds; one holding over
 *     `idleKeepBytes` is replaced by a clean worker (see replaceIfHeavy).
 *   - crash recovery: a dead worker is respawned and its in-flight call retried
 *     once; a poison call that keeps crashing fails gracefully (never wedges the
 *     pool). A crash budget trips a circuit breaker (`healthy` → false) so the
 *     caller falls back to in-process dispatch instead of thrashing respawns.
 *   - graceful backstop: a call that can't be served within `softTimeoutMs`
 *     resolves with SUCCESS-shaped "busy, retry" guidance — never `isError`, so
 *     a momentary overload can't teach the agent to abandon codegraph — instead
 *     of hanging past the client's hard timeout.
 *   - project release: `releaseProject(root)` asks every worker to close its
 *     own connection to one project (a removed worktree's index, whether this
 *     process's sweep tore it down or the engine's housekeeping pass found its
 *     database gone), so the database's blocks are freed once deleted. It is
 *     a broadcast: the pool does not track which worker opened which root;
 *     see that method.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import type { ToolResult } from './tools';

/** Compiled sibling — `query-worker.js` lives next to this file in `dist/mcp/`. */
const WORKER_FILE = path.join(__dirname, 'query-worker.js');

/**
 * Minimal worker surface the pool drives — satisfied by a real `worker_threads`
 * Worker. Abstracted so tests can inject a fake worker and exercise the pool's
 * queue / growth / idle-retirement / crash-recovery / backstop logic without
 * spawning threads or needing a built `dist/`. The pool posts `call`, `release`,
 * `trim` and `retire` messages; the worker posts `ready`, `result`, `released`,
 * `trimmed` and `retired`.
 */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', cb: (m: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
}

/** Default linger before a queued call is answered with busy-guidance. */
const DEFAULT_BUSY_TIMEOUT_MS = 45_000; // < the ~60s MCP client request timeout

/**
 * Most the last started worker may still hold after its idle trim and stay. A
 * trimmed worker holds about 80 MB, mostly heap and tree-sitter's wasm, whatever
 * the size of the project; one above this holds something that won't come back
 * in place, so it costs less to replace it than to keep it for the rest of the
 * session.
 */
const DEFAULT_IDLE_KEEP_BYTES = 256 * 1024 * 1024;

/** Hard ceiling on pool size regardless of core count / env. */
const MAX_POOL_SIZE = 16;

/**
 * Total worker deaths before the pool declares itself unhealthy and the caller
 * reverts to in-process dispatch. High enough to ride out a few transient
 * crashes, low enough that a systematically-broken worker (e.g. a platform that
 * can't spawn threads) degrades quickly instead of respawning forever.
 */
const CRASH_BUDGET = 12;

/**
 * Max workers cold-starting at once. A worker's cold start is heavy — full
 * module load (tree-sitter etc.) + opening a large WAL DB — and starting the
 * whole pool simultaneously thrashes CPU/I-O so badly it can stall the daemon's
 * main loop for tens of seconds. Warming a couple at a time keeps each start
 * fast; as one reports ready the next begins, so the pool still reaches full
 * size within a few calls of a burst, just without the thundering herd.
 */
const MAX_CONCURRENT_SPAWN = 2;

/**
 * How long `destroy()` waits for a worker that is still starting up before
 * terminating it anyway. Terminating a worker while it is still loading its
 * modules can take the whole process down with an access violation
 * (0xC0000005, seen on Windows), and the daemon shuts its pool down whenever
 * it stops — a session that ends within a few seconds of starting has a
 * worker in exactly that state. A start takes about a second normally and a
 * few under heavy load; the cap only bounds a start that is wedged. The same
 * cap bounds how long a retired worker gets to exit before it is terminated:
 * both bound a wedged worker, so they share one cap.
 */
const WORKER_START_SETTLE_MS = 15_000;

/**
 * Default idle time before a worker above the floor is retired. Long enough
 * to ride out the gaps inside a subagent wave (an agent reading one answer
 * before its next call), so a burst keeps its workers; short against what one
 * costs to keep: about 300 MB plus its own SQLite connection per project.
 * Retiring one too early costs only one worker cold start on the next burst.
 */
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 60_000;

/**
 * Default idle time before the last started worker is trimmed in place. Five
 * minutes: an ordinary pause (reading, thinking, a break of a few minutes) must
 * not empty the page cache and the project caches the worker holds, so the next
 * call finds them warm. Longer than the default retirement delay on purpose:
 * spares cost a whole worker each and
 * go quickly, while the one worker left costs only its caches. Applies only to
 * that last worker's trim, never to the retirement of spares.
 */
const DEFAULT_IDLE_SHRINK_MS = 300_000;

/**
 * Started workers the idle retirement never goes below (a worker still starting
 * does not count). One, not zero: `ready` stays true through the retirement (it
 * drops only while a worker too heavy to keep is replaced) and the ToolHandler
 * routes to the pool on `healthy && ready`, so a pool shrunk to nothing would
 * queue the next call behind a cold start, the #662 first-call stall `ready`
 * exists to avoid.
 */
const MIN_STARTED_WORKERS = 1;

/** setTimeout's ceiling; a longer delay would fire after 1 ms instead. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Bound on how long `releaseProject` waits for a worker's `released` ack. A
 * worker answers once any call it is running on that project finishes; this
 * only bounds a wedged one. Shares the start-settle cap: both bound a worker
 * that has stopped answering.
 */
const RELEASE_ACK_TIMEOUT_MS = WORKER_START_SETTLE_MS;

/**
 * Shape of a message a worker posts back: the `ready` handshake, a tool
 * `result`, a `released` ack (with `error` when its close failed), `trimmed`
 * (with `heldBytes`), or `retired`.
 */
interface WorkerMessage {
  type?: string;
  ok?: boolean;
  id?: number;
  result?: ToolResult;
  error?: string;
  /** On 'trimmed': the heap and buffers the worker still holds. */
  heldBytes?: number;
}

/** One `releaseProject` call: the workers that have not acked yet. */
interface PendingRelease {
  root: string;
  waiting: Set<PoolWorker>;
  failures: string[];
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Job {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (r: ToolResult) => void;
  retries: number;
  settled: boolean;
  enqueuedAt: number;
  softTimer?: NodeJS.Timeout;
}

export interface QueryPoolOptions {
  /** Max worker threads. Defaults to `clamp(cores-1, 1, 16)`. */
  size?: number;
  /** Linger before a queued call gets busy-guidance. Default 45s. */
  softTimeoutMs?: number;
  /** Retries for an in-flight call whose worker crashed. Default 1. */
  maxRetries?: number;
  /**
   * The last started worker, once trimmed in place, is replaced when it still
   * holds more than this many bytes of heap and buffers. Default 256 MB; `0`
   * replaces any trimmed worker.
   */
  idleKeepBytes?: number;
  /** Worker factory (tests inject a fake). Defaults to a real `worker_threads` Worker. */
  createWorker?: () => PoolWorker;
  /**
   * How long destroy() waits on a worker still starting up, and how long a
   * retired worker gets to exit before it is terminated (tests shorten it).
   * Default 15s.
   */
  startSettleMs?: number;
  /**
   * How long a worker may sit idle before it is retired, down to one started
   * worker (a worker still starting does not count toward the floor). `0` (or a
   * negative or non-finite value) never retires. Its clock governs only the
   * retirement; it also decides whether a grown pool ever reaches the one worker
   * that is trimmed: the worker that stays is trimmed after `idleShrinkMs`. With `0`
   * a pool that has grown never gets back down to one worker, so it is never
   * trimmed either (the trim is only for the one worker left); a pool that
   * never grew is trimmed after `idleShrinkMs`. Default
   * `resolveWorkerIdleTimeoutMs(process.env.CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS)`.
   */
  idleTimeoutMs?: number;
  /**
   * How long the last started worker stays idle before it is trimmed in place
   * (it keeps running, but closes every project but the last one used and gives
   * its connections' page cache back). Its clock is its own; the trim still waits
   * for the pool to reach one started worker (see `idleTimeoutMs`) and for a call
   * served since the last trim. `0` (or
   * a negative or non-finite value) never trims. Default 5 min.
   */
  idleShrinkMs?: number;
}

/**
 * Resolve the pool size from the `CODEGRAPH_QUERY_POOL_SIZE` override and the
 * machine's core count. `0` (or a negative) explicitly disables the pool (the
 * caller serves in-process — today's behavior). Unset → `clamp(cores-1, 1, 16)`:
 * leave a core for the main loop + OS, but never zero, since even one worker
 * frees the transport and lets responses flush incrementally.
 */
export function resolvePoolSize(envVal: string | undefined, cpuCount: number): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), MAX_POOL_SIZE);
    // non-numeric / negative → fall through to the default
  }
  return Math.max(1, Math.min(cpuCount - 1, MAX_POOL_SIZE));
}

function resolveBusyTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUSY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Resolve the worker idle timeout from `CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS`.
 * Unset or blank → 60s (DEFAULT_WORKER_IDLE_TIMEOUT_MS); a finite number >= 0
 * is floored, and `0` means never retire; a negative or non-numeric value
 * falls back to the default. Blank is checked after trimming because
 * `Number(' ')` is 0, which would silently turn retirement off.
 */
export function resolveWorkerIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WORKER_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WORKER_IDLE_TIMEOUT_MS;
  return Math.floor(n);
}

/** Success-shaped overload guidance (NEVER isError — see the abandonment rule). */
function busyGuidance(waitedMs: number): ToolResult {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  return {
    content: [{
      type: 'text',
      text:
        `CodeGraph is busy serving other concurrent requests right now (this call waited ${secs}s in the queue). ` +
        `This is NOT an error and the index is fine — wait a few seconds and retry this exact call; it will return normally. ` +
        `If you can't wait, use your built-in tools for just this one step.`,
    }],
  };
}

export class QueryPool {
  private idle: PoolWorker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<PoolWorker, Job>();
  private workers = new Set<PoolWorker>();
  // Workers spawned but not yet 'ready'. Growth must count these so a single
  // first call (with the eager worker still starting) doesn't spawn the WHOLE
  // pool at once — N simultaneous cold worker starts (each a full module load +
  // a large DB open) saturate the box and starve the main loop. Grow only when
  // the queue outstrips idle + pending.
  private pendingWorkers = new Set<PoolWorker>();
  // Each worker's start, settled when it posts 'ready' (either way) or goes
  // away — what destroy() waits on before terminating it (see
  // WORKER_START_SETTLE_MS).
  private starts = new Map<PoolWorker, { settled: Promise<void>; settle: () => void }>();
  // When each worker in `idle` last became idle: what the idle retirement
  // (idleTimeoutMs) and the idle trim (idleShrinkMs) both age.
  private idleSince = new Map<PoolWorker, number>();
  // Workers told to retire and not yet gone. They are already out of `workers`
  // and `idle`; their exit or error lands here, never in onWorkerGone. `gone`
  // resolves once the worker has exited or been terminated; `cap` terminates
  // it if it has not exited within `startSettleMs`. `terminating` marks one
  // whose terminate() was called and has not settled: it stays in this map
  // until then, even through its own exit or error, so destroy() still waits
  // on its `gone`.
  private retiring = new Map<PoolWorker, {
    gone: Promise<void>; done: () => void; cap: NodeJS.Timeout; terminating: boolean;
  }>();
  // One unref'd timer, armed for the earliest due retirement.
  private retireTimer: NodeJS.Timeout | null = null;
  // In-flight releaseProject calls by id. A worker leaves `waiting` on its
  // ack; once it has stopped (its 'exit', or its terminate() settling); or at
  // once when the release could not be posted to it. That last one is not
  // waited for unless its termination was already pending when the release
  // began. An 'error' alone does not count: the thread is still on its way out.
  private releases = new Map<number, PendingRelease>();
  // Each worker's termination once terminate() was called on it (settled when
  // the thread has stopped), so every caller waits on the one termination.
  private terminations = new WeakMap<PoolWorker, Promise<void>>();
  // Terminations not settled yet: releaseProject and destroy() wait for them,
  // since a worker being terminated may still hold its connections.
  private pendingTerminations = new Set<Promise<void>>();
  // Set by destroy(): settles once every worker has stopped. A release asked
  // for after destroy() started waits on it.
  private destroying: Promise<void> | null = null;
  private nextReleaseId = 1;
  private nextId = 1;
  private totalCrashes = 0;
  private destroyed = false;
  private readonly maxSize: number;
  private readonly softTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createWorker: () => PoolWorker;
  private readonly startSettleMs: number;
  private readonly idleTimeoutMs: number;
  private readonly idleShrinkMs: number;
  private readonly idleKeepBytes: number;
  // Set by a served call and cleared when the last worker is trimmed, so a
  // worker that has answered nothing since is left alone rather than trimmed
  // again for its own sake.
  private servedSinceTrim = false;
  // The worker that answered last, which is the one worth keeping: its caches
  // and its compiled code are what the next call would otherwise rebuild. The
  // idle retirement leaves it for last among the idle workers (retireCandidate).
  private lastServer?: PoolWorker;

  constructor(opts: QueryPoolOptions) {
    this.maxSize = Math.max(1, Math.min(opts.size ?? Math.max(1, os.cpus().length - 1), MAX_POOL_SIZE));
    this.softTimeoutMs = opts.softTimeoutMs ?? resolveBusyTimeoutMs();
    this.maxRetries = opts.maxRetries ?? 1;
    this.idleKeepBytes = opts.idleKeepBytes ?? DEFAULT_IDLE_KEEP_BYTES;
    // A pool worker opens no project at spawn: every call names its project
    // (the machine server has no default one), and the worker opens it lazily.
    this.createWorker = opts.createWorker ?? (() => new Worker(WORKER_FILE, { workerData: { root: null } }));
    this.startSettleMs = opts.startSettleMs ?? WORKER_START_SETTLE_MS;
    const idleMs = opts.idleTimeoutMs ?? resolveWorkerIdleTimeoutMs(process.env.CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS);
    this.idleTimeoutMs = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 0;
    const shrinkMs = opts.idleShrinkMs ?? DEFAULT_IDLE_SHRINK_MS;
    this.idleShrinkMs = Number.isFinite(shrinkMs) && shrinkMs > 0 ? shrinkMs : 0;
    this.spawnOne(); // one eager warm worker, ready for the first call
  }

  /** Pool size cap (for logging/status). */
  get size(): number { return this.maxSize; }

  /** Live worker count (for tests/status). A retiring worker no longer counts. */
  get liveWorkers(): number { return this.workers.size; }

  /**
   * False once the crash budget is exhausted (or after destroy). The ToolHandler
   * checks this and falls back to in-process dispatch — a broken worker platform
   * degrades to today's behavior instead of failing tool calls.
   */
  get healthy(): boolean {
    return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
  }

  /**
   * True once at least one worker has completed its cold start (posted the
   * 'ready' handshake). Until then the ToolHandler serves calls IN-PROCESS:
   * a worker cold start is a full module load + DB open — seconds normally,
   * tens of seconds on a loaded machine — and a call queued behind it gets
   * nothing until the 45s busy backstop. The daemon's very first tool call
   * hitting that window was the recurring #662 test flake (and a real
   * first-call stall for agents). The pool exists for CONCURRENT load, which
   * by definition arrives after warm-up; the pre-pool in-process path is
   * strictly better while nothing is warm, which also holds while the
   * replacement for a worker too heavy to keep starts (replaceIfHeavy). Stays
   * true across the idle retirement, which never retires below
   * MIN_STARTED_WORKERS, and across the trim of the one worker left, which runs
   * in place after `idleShrinkMs` and never stops it; and across crash-respawn
   * gaps, which are covered by retry + backstop.
   */
  get ready(): boolean {
    return this.everReady && !this.destroyed;
  }
  private everReady = false;

  private spawnOne(): void {
    if (this.destroyed || this.workers.size >= this.maxSize) return;
    let w: PoolWorker;
    try {
      w = this.createWorker();
    } catch {
      this.totalCrashes++; // counts toward the circuit breaker
      return;
    }
    this.workers.add(w);
    this.pendingWorkers.add(w);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    this.starts.set(w, { settled, settle });
    w.on('message', (m) => this.onMessage(w, (m ?? {}) as WorkerMessage));
    // A retiring worker's exit (any code) or error belongs to a deliberate
    // retirement, not a crash: endRetiring takes it and the crash path never
    // sees it. On its exit it leaves the retiring set, unless its terminate()
    // is still pending (see endRetiring); on an error it is terminated, and
    // leaves the set once that settles. An error does not end a pending
    // release for the worker: the thread has not stopped yet, so the release
    // waits for its exit or its termination (onWorkerGone terminates it).
    w.on('error', () => {
      this.startSettled(w);
      if (!this.endRetiring(w, true)) this.onWorkerGone(w);
    });
    w.on('exit', (code) => {
      this.startSettled(w);
      this.releaseAcked(w, null);
      if (!this.endRetiring(w, false) && code !== 0) this.onWorkerGone(w);
    });
  }

  /** Put a worker on the idle stack and note when it became idle. */
  private toIdle(w: PoolWorker): void {
    this.idle.push(w);
    this.idleSince.set(w, Date.now());
  }

  private onMessage(w: PoolWorker, m: WorkerMessage): void {
    // Before the let-go check below: destroy() waits on this for a worker it
    // has already let go of.
    if (m?.type === 'ready') this.startSettled(w);
    // A release ack counts from any worker the release was sent to, a
    // retiring one included: it closed the project either way.
    if (m?.type === 'released') {
      this.releaseAcked(w, typeof m.id === 'number' ? m.id : null, m.ok === false ? (m.error ?? 'release failed') : undefined);
      return;
    }
    // Ignore messages from workers the pool has let go of: retiring ones
    // (their 'retired' reply included) and ones a crash or destroy() removed.
    if (!m || !this.workers.has(w)) return;
    if (m.type === 'ready') {
      if (!this.pendingWorkers.delete(w)) return; // already handled this handshake
      if (m.ok === false) {
        this.onWorkerGone(w); // failed opens consume the same budget as crashes
        return;
      }
      this.everReady = true;
      this.toIdle(w);
      this.drain();
      return;
    }
    if (m.type === 'result') {
      const job = this.inflight.get(w);
      this.inflight.delete(w);
      this.toIdle(w);
      this.servedSinceTrim = true;
      this.lastServer = w;
      if (job) this.settle(job, m.result ?? busyGuidance(0));
      this.drain();
    }
    if (m.type === 'trimmed') this.replaceIfHeavy(w, m.heldBytes ?? 0);
  }

  /** Nothing queued or running, nothing starting, and every worker free. */
  private get quiescent(): boolean {
    return !this.destroyed && this.queue.length === 0 && this.inflight.size === 0 &&
      this.pendingWorkers.size === 0 && this.idle.length === this.workers.size;
  }

  /**
   * The last check on the last started worker after its idle trim (it reports
   * what it still holds): one that holds a lot is retired like the others, with
   * one clean worker in its place, so that keeping a worker can't keep hold of
   * what a large query left behind. Calls that come while the clean one starts
   * are served in process (`ready` is false until it is up). Back at work by
   * now, it is left alone, and judged at its next trim.
   */
  private replaceIfHeavy(w: PoolWorker, heldBytes: number): void {
    if (heldBytes <= this.idleKeepBytes || !this.quiescent || this.workers.size !== 1) return;
    this.everReady = false;
    this.retire(w);
    this.spawnOne();
  }

  // A worker died (crash hook, OOM, segfault, exit≠0). Respawn a replacement and
  // retry its in-flight job once; a job that keeps crashing workers fails
  // gracefully so it can't loop the pool forever. A retired worker's exit is
  // deliberate and never reaches here: it goes to endRetiring.
  private onWorkerGone(w: PoolWorker): void {
    if (!this.workers.has(w)) return; // already handled (error+exit both fire)
    this.workers.delete(w);
    this.pendingWorkers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.idleSince.delete(w);
    if (this.lastServer === w) this.lastServer = undefined;
    this.totalCrashes++;
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    void this.terminateWorker(w);
    if (this.healthy) this.spawnOne(); // keep capacity
    if (job) {
      if (job.retries < this.maxRetries && this.healthy) {
        job.retries++;
        this.queue.unshift(job); // head of line — retry promptly
      } else {
        this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph worker crashed; please retry the call.' }] });
      }
    }
    this.drain();
  }

  private drain(): void {
    // Grow toward maxSize while queued work outstrips workers that are idle OR
    // already on their way up (pending) — so we never spawn the whole pool for a
    // single call whose eager worker just hasn't reported ready yet.
    while (
      this.queue.length > this.idle.length + this.pendingWorkers.size &&
      this.workers.size < this.maxSize &&
      this.pendingWorkers.size < MAX_CONCURRENT_SPAWN &&
      this.healthy
    ) {
      this.spawnOne();
    }
    while (this.idle.length && this.queue.length) {
      // Skip jobs the backstop already answered.
      let job: Job | undefined;
      while (this.queue.length && (job = this.queue.shift()) && job.settled) job = undefined;
      if (!job || job.settled) break;
      // LIFO: the most recently idle worker takes the call, so the oldest idle
      // ones keep aging toward retirement.
      const w = this.idle.pop()!;
      this.idleSince.delete(w);
      this.inflight.set(w, job);
      w.postMessage({ type: 'call', id: job.id, toolName: job.toolName, args: job.args });
    }
    this.scheduleRetire();
  }

  /** Started workers above the floor may retire; a pending one is not warm yet. */
  private canRetire(): boolean {
    return this.workers.size - this.pendingWorkers.size > MIN_STARTED_WORKERS;
  }

  /**
   * The idle worker the next retirement takes: the oldest idle one, except
   * the worker that served last, which is the one worth keeping (see
   * `lastServer`) and goes only when it is the sole idle worker (the others
   * are running a call or still starting). `idle` is in idle order, oldest first, so the first
   * one that is not `lastServer` has the earliest deadline of those that can go.
   */
  private retireCandidate(): PoolWorker | undefined {
    return this.idle.find((w) => w !== this.lastServer) ?? this.idle[0];
  }

  /**
   * The last started worker is due its trim: nothing else is running, queued
   * or starting, it has served since it was last trimmed, and (checked by the
   * caller against its deadline) it has been idle for `idleShrinkMs`. A pool
   * above the floor is not due: it retires first, so with `idleTimeoutMs` 0 a
   * pool that has grown is never trimmed.
   */
  private trimCandidate(): PoolWorker | undefined {
    if (this.canRetire() || !this.servedSinceTrim || !this.quiescent) return undefined;
    return this.idle[0];
  }

  /**
   * Arm the timer for the earliest idle deadline: the retirement candidate's
   * (`idleTimeoutMs`) while the pool is above its floor, else the last
   * worker's trim (`idleShrinkMs`). Each clock is skipped when its own option
   * is 0. Clears the timer when neither can happen.
   */
  private scheduleRetire(): void {
    if (this.retireTimer) clearTimeout(this.retireTimer);
    this.retireTimer = null;
    if (this.destroyed) return;
    let next: PoolWorker | undefined;
    let waitMs: number;
    if (this.canRetire()) {
      if (this.idleTimeoutMs <= 0) return;
      next = this.retireCandidate();
      waitMs = this.idleTimeoutMs;
    } else {
      if (this.idleShrinkMs <= 0) return;
      next = this.trimCandidate();
      waitMs = this.idleShrinkMs;
    }
    if (!next) return;
    const since = this.idleSince.get(next) ?? Date.now();
    const delay = Math.min(Math.max(1, since + waitMs - Date.now()), MAX_TIMER_DELAY_MS);
    this.retireTimer = setTimeout(() => {
      this.retireTimer = null;
      this.retireIdle();
    }, delay);
    this.retireTimer.unref?.();
  }

  /**
   * Retire workers idle past `idleTimeoutMs`, down to the floor, then trim the
   * worker that is left if it has been idle for `idleShrinkMs`.
   */
  private retireIdle(): void {
    if (this.destroyed) return;
    const now = Date.now();
    while (this.idleTimeoutMs > 0 && this.canRetire()) {
      const w = this.retireCandidate();
      if (!w) break;
      if (now - (this.idleSince.get(w) ?? now) < this.idleTimeoutMs) break;
      this.retire(w);
    }
    const last = this.idleShrinkMs > 0 ? this.trimCandidate() : undefined;
    if (last && now - (this.idleSince.get(last) ?? now) >= this.idleShrinkMs) this.trim(last);
    this.scheduleRetire();
  }

  /**
   * Ask the last started worker to shrink in place and report what it still
   * holds (answered by `trimmed`, see replaceIfHeavy). It stays in `idle`, so a
   * call that comes meanwhile is served by it: the worker handles the trim
   * first and the call right after, a few milliseconds later.
   */
  private trim(w: PoolWorker): void {
    this.servedSinceTrim = false;
    try {
      w.postMessage({ type: 'trim' });
    } catch { /* already gone: its 'exit' recovers the pool */ }
  }

  /**
   * Retire one idle worker: drop it from the live set at once (so `liveWorkers`
   * falls immediately), then ask it to close its connections and exit. Only
   * idle workers get here, never one with a call in flight or one still
   * starting (a worker must not end mid-start, src/worker-teardown.ts).
   */
  private retire(w: PoolWorker): void {
    this.workers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.idleSince.delete(w);
    if (this.lastServer === w) this.lastServer = undefined;
    let done!: () => void;
    const gone = new Promise<void>((resolve) => { done = resolve; });
    const cap = setTimeout(() => { this.endRetiring(w, true); }, this.startSettleMs);
    cap.unref?.();
    this.retiring.set(w, { gone, done, cap, terminating: false });
    try {
      w.postMessage({ type: 'retire' });
    } catch {
      this.endRetiring(w, true);
    }
  }

  /**
   * End a worker's retirement. On its exit (`terminate` false) it leaves the
   * retiring set at once. With `terminate` (it raised an error, has not exited
   * within `startSettleMs`, or the retire message could not be posted) it is
   * terminated and stays in the set, marked `terminating`, until terminate()
   * settles, so destroy() and releaseProject wait for it. An exit or error in
   * that window still lands here and changes nothing: only terminate()
   * settling releases the worker. Returns true for any retiring worker, so its
   * exit or error never reaches onWorkerGone; false when the worker was not
   * retiring, so the caller handles the event itself.
   */
  private endRetiring(w: PoolWorker, terminate: boolean): boolean {
    const r = this.retiring.get(w);
    if (!r) return false;
    if (r.terminating) return true;
    clearTimeout(r.cap);
    if (!terminate) {
      this.retiring.delete(w);
      r.done();
      return true;
    }
    r.terminating = true;
    void this.terminateWorker(w).then(() => {
      if (this.retiring.get(w) === r) this.retiring.delete(w);
      r.done();
    });
    return true;
  }

  /**
   * Terminate `w` once, whoever asks: the promise settles (never rejects)
   * when its terminate() has, i.e. the thread has stopped, and every caller
   * gets the same one. While it is pending the worker counts as holding its
   * connections (`pendingTerminations`); once it settles the worker leaves
   * every pending release.
   */
  private terminateWorker(w: PoolWorker): Promise<void> {
    const known = this.terminations.get(w);
    if (known) return known;
    let ended: Promise<unknown>;
    try {
      ended = Promise.resolve(w.terminate());
    } catch {
      ended = Promise.resolve(); // already gone
    }
    const stopped: Promise<void> = ended.then(() => undefined, () => undefined).then(() => {
      this.pendingTerminations.delete(stopped);
      this.releaseAcked(w, null);
    });
    this.terminations.set(w, stopped);
    this.pendingTerminations.add(stopped);
    return stopped;
  }

  /**
   * Close `root` on every worker: post `{ type: 'release', id, root }` to each
   * live worker (busy and still-starting ones included; a worker handles it
   * after the call it is running) and resolve once each has acked with
   * `released` or gone away. The worker closes the project through its own
   * ToolHandler's releaseProjectRoot, which waits for every call the worker is
   * running first; a later call that names the project simply opens it again.
   * It also waits for every worker retiring when it is called: retirement
   * takes a worker out of the live set before the worker has closed its
   * connections, which it does only on its way out, so its exit (or, past
   * its start-settle cap, its termination) is what frees the project there.
   * Likewise for every worker whose termination is pending (one that crashed
   * or raised an error): it may hold the project until its terminate()
   * settles. A live worker that raises an error before it acks leaves the
   * release the same way, once its termination settles.
   *
   * Rejects when a worker reports its close failed, or has not acked within
   * RELEASE_ACK_TIMEOUT_MS: the caller must not treat that project's files as
   * free. Resolves at once with no live, retiring or terminating workers.
   * Once destroy() has started it answers destroy's own termination: it
   * resolves when every worker has stopped.
   */
  releaseProject(root: string): Promise<void> {
    if (this.destroyed) return this.destroying ?? Promise.resolve();
    const leaving = [...[...this.retiring.values()].map((r) => r.gone), ...this.pendingTerminations];
    const acked = this.postRelease(root);
    return leaving.length === 0 ? acked : Promise.all([acked, ...leaving]).then(() => undefined);
  }

  /** The live-worker half of {@link releaseProject}: post and collect acks. */
  private postRelease(root: string): Promise<void> {
    const targets = [...this.workers];
    if (targets.length === 0) return Promise.resolve();
    const id = this.nextReleaseId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.releases.get(id);
        if (!pending) return;
        this.releases.delete(id);
        reject(new Error(`query worker(s) did not release ${root} within ${RELEASE_ACK_TIMEOUT_MS} ms`));
      }, RELEASE_ACK_TIMEOUT_MS);
      timer.unref?.();
      const pending: PendingRelease = { root, waiting: new Set(targets), failures: [], resolve, reject, timer };
      this.releases.set(id, pending);
      for (const w of targets) {
        try {
          w.postMessage({ type: 'release', id, root });
        } catch {
          pending.waiting.delete(w); // could not reach it: it is going away
        }
      }
      this.finishRelease(id);
    });
  }

  /**
   * Worker `w` acked release `id` (`failure` set when its close failed), or,
   * with `id` null, went away: it leaves every pending release.
   */
  private releaseAcked(w: PoolWorker, id: number | null, failure?: string): void {
    const ids = id === null ? [...this.releases.keys()] : [id];
    for (const rid of ids) {
      const pending = this.releases.get(rid);
      if (!pending || !pending.waiting.delete(w)) continue;
      if (failure) pending.failures.push(failure);
      this.finishRelease(rid);
    }
  }

  /** Settle release `id` once no worker is left to ack it. */
  private finishRelease(id: number): void {
    const pending = this.releases.get(id);
    if (!pending || pending.waiting.size > 0) return;
    this.releases.delete(id);
    clearTimeout(pending.timer);
    if (pending.failures.length > 0) {
      pending.reject(new Error(`query worker could not release ${pending.root}: ${pending.failures.join('; ')}`));
    } else {
      pending.resolve();
    }
  }

  private settle(job: Job, result: ToolResult): void {
    if (job.settled) return; // already answered (by backstop or worker)
    job.settled = true;
    if (job.softTimer) clearTimeout(job.softTimer);
    job.resolve(result);
  }

  /** Run a read tool on the pool. Always resolves (never rejects). */
  run(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const job: Job = {
        id: this.nextId++, toolName, args, resolve,
        retries: 0, settled: false, enqueuedAt: Date.now(),
      };
      // Don't let the caller wait past softTimeoutMs. The worker may still be
      // busy (we can't cancel synchronous CPU), but the CLIENT gets a prompt,
      // success-shaped "retry" instead of a hard timeout.
      job.softTimer = setTimeout(() => {
        if (!job.settled) this.settle(job, busyGuidance(Date.now() - job.enqueuedAt));
      }, this.softTimeoutMs);
      job.softTimer.unref?.();
      this.queue.push(job);
      this.drain();
    });
  }

  private startSettled(w: PoolWorker): void {
    const start = this.starts.get(w);
    if (!start) return;
    this.starts.delete(w);
    start.settle();
  }

  /**
   * Terminate a worker, but not while it is still starting up: wait for it to
   * post 'ready' (or go away), up to `startSettleMs` (WORKER_START_SETTLE_MS —
   * see that constant for the crash this avoids).
   */
  private async terminateStarted(w: PoolWorker): Promise<void> {
    const start = this.starts.get(w);
    if (start) {
      let cap: NodeJS.Timeout | undefined;
      await Promise.race([
        start.settled,
        new Promise<void>((resolve) => { cap = setTimeout(resolve, this.startSettleMs); cap.unref?.(); }),
      ]);
      clearTimeout(cap);
    }
    await this.terminateWorker(w);
  }

  /**
   * Terminate all workers and answer any outstanding calls gracefully. A worker
   * still starting up is terminated once it has started (see
   * WORKER_START_SETTLE_MS); outstanding calls are answered first. A worker
   * already retiring keeps the rest of its `startSettleMs` to exit and is then
   * terminated, and one already being terminated (retiring, or after a crash)
   * is waited for until its terminate() settles, so none is left running when
   * this resolves. A pending releaseProject, and any asked for from now on,
   * resolves with it, once every worker has stopped: their connections close
   * as they stop. A second call returns the first one's promise.
   */
  destroy(): Promise<void> {
    if (this.destroying) return this.destroying;
    this.destroyed = true;
    if (this.retireTimer) clearTimeout(this.retireTimer);
    this.retireTimer = null;
    const ws = [...this.workers];
    const retiring = [...this.retiring.values()].map((r) => r.gone);
    const terminating = [...this.pendingTerminations];
    this.workers.clear();
    this.pendingWorkers.clear();
    this.idle = [];
    this.idleSince.clear();
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph is shutting down; retry shortly.' }] });
    }
    this.inflight.clear();
    this.queue = [];
    const stopped = Promise.all([...ws.map((w) => this.terminateStarted(w)), ...retiring, ...terminating])
      .then(() => undefined);
    this.destroying = stopped;
    // Every pending release now waits for the workers to stop, not for acks:
    // a worker being terminated never sends one.
    const pending = [...this.releases.values()];
    this.releases.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      void stopped.then(() => p.resolve());
    }
    return stopped;
  }
}
