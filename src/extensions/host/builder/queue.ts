/**
 * The index builder's job queue: two lanes, each running one job at a time (./job-lane.ts picks the lane).
 *
 * The `sync` lane runs the short jobs (`sync`, `catch-up`, `watch-sync`, `seed`, `recover`, `open`): a changed
 * file or two, a copy of an index, the writable open of one (its migrations and repairs). The `cold` lane runs
 * the whole-repository writes (`cold-build`, and the CLI's `init` and `index`, ./cli-jobs.ts), which run for
 * minutes. The lanes run beside each other, so an edit of an indexed root becomes visible while another root's
 * cold build runs.
 *
 * One writer per root: a job starts only when none of its roots (its own and its `alsoRoots`) is a root of a
 * running job in either lane. The sync lane starts its first waiting job whose roots are free
 * (./first-startable.ts), so jobs of one root keep their order. The cold lane is first in, first out: it
 * starts only its head, and only when the head's roots are not running and no waiting sync job names one of
 * them, so a root's queued syncs go before its cold write. A running job is never preempted: the queue cannot
 * interrupt an index run halfway (a job over its limit ends the whole builder process instead,
 * ./job-limit-guard.ts).
 *
 * {@link JobQueue.whenRootIdle} tells when no job of one root runs or waits (the release of an index being
 * removed waits on it, ./cli-relay.ts); the jobs are keyed by the root's canonical spelling.
 *
 * Every job is logged as it starts and ends, through `onEvent`; the builder writes those as the lines of
 * `<state dir>/builder.log`.
 *
 * A job ended over a limit (./job-limit-guard.ts) is refused here afterwards: a later enqueue of the same root
 * and kind rejects with {@link JobEndedError} (./ended-jobs.ts holds the marks). Cold builds are refused by
 * their own body instead (cold-build.ts), and `init` and `index` never are: they are the explicit way to try
 * again, and one that ends ok clears its root's marks.
 */
import { canonicalProjectRoot } from '../../../directory';
import { endedJobs } from './ended-jobs';
import { firstStartable } from './first-startable';
import { JobEndedError } from './job-ended-error';
import { jobLane } from './job-lane';
import type { JobLane, RunningJob } from './running-job';

/**
 * What a job does, and so which lane it runs in (./job-lane.ts). `sync` is a caller's sync (the server's, or
 * the CLI's `sync`); `init` and `index` are the CLI's whole-repository index writes (./cli-jobs.ts).
 */
export type JobKind = 'sync' | 'catch-up' | 'watch-sync' | 'seed' | 'cold-build' | 'init' | 'index' | 'recover' | 'open';

/** The kinds an ended mark never refuses at enqueue: `init` and `index` are the explicit retry; a cold build refuses in its body (cold-build.ts). */
const NEVER_REFUSED: ReadonlySet<JobKind> = new Set<JobKind>(['cold-build', 'init', 'index']);

/** One job's start or end, for the log. `error` is set on a failed end, one line. */
export type JobEvent =
  | { edge: 'start'; kind: JobKind; root: string }
  | { edge: 'end'; kind: JobKind; root: string; ok: boolean; error?: string };

/**
 * A job event as a line of `<state dir>/builder.log`:
 * `<ISO8601> job start <kind> <root>` and `<ISO8601> job end <kind> <root> ok|failed[: msg]`.
 */
export function formatJobLine(event: JobEvent, now: Date = new Date()): string {
  const stamp = now.toISOString();
  if (event.edge === 'start') return `${stamp} job start ${event.kind} ${event.root}`;
  return `${stamp} job end ${event.kind} ${event.root} ${event.ok ? 'ok' : `failed: ${event.error ?? 'unknown error'}`}`;
}

export interface JobQueueOptions {
  onEvent?: (event: JobEvent) => void;
}

export interface EnqueueOptions {
  /**
   * Share one queued job between callers: while a job with this key is queued and has not started, another
   * enqueue with the same key returns that job's promise instead of queuing a second. A job that is already
   * running is not shared, since a sync that started before the caller asked may have missed its change.
   */
  coalesceKey?: string;
  /**
   * Other roots the job reads or opens besides its own `root` (a seed reads its source's database). Matched
   * like `root` by {@link JobQueue.whenRootIdle}: the job counts as a job of each of them while it is queued or running.
   */
  alsoRoots?: readonly string[];
}

interface Entry {
  kind: JobKind;
  root: string;
  /** `root` and its {@link EnqueueOptions.alsoRoots} in their canonical spelling, taken when the job was queued; what {@link JobQueue.whenRootIdle} matches. */
  rootKeys: readonly string[];
  coalesceKey: string | undefined;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

/** The message of a failure as one log line: no line breaks, bounded. */
function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

export class JobQueue {
  private readonly syncJobs: Entry[] = [];
  private readonly coldJobs: Entry[] = [];
  /** Queued, not started, entries by coalesce key. */
  private readonly byKey = new Map<string, Entry>();
  /** The job each lane runs now, with its id. */
  private readonly running = new Map<JobLane, { entry: Entry; id: number }>();
  /** The id of the job started last, in either lane: 1 for the first, one more for each next. */
  private lastId = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  /** Callers of {@link whenRootIdle}, by the canonical root they wait on. */
  private rootWaiters: Array<{ rootKey: string; resolve: () => void }> = [];

  constructor(private readonly options: JobQueueOptions = {}) {}

  /**
   * Queue a job. Resolves with `run`'s value, rejects with its error (the failure is logged as well). A
   * closed queue rejects at once, and so does a root and kind ended over a limit (a {@link JobEndedError},
   * with no run and no log line), except the {@link NEVER_REFUSED} kinds. An `init` or `index` that ends ok
   * clears its root's ended marks.
   */
  enqueue<T>(kind: JobKind, root: string, run: () => Promise<T>, opts: EnqueueOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the index builder is stopping'));
    const ended = NEVER_REFUSED.has(kind) ? undefined : endedJobs.find(root, kind);
    if (ended) return Promise.reject(new JobEndedError(root, kind, ended.limit));
    const key = opts.coalesceKey;
    if (key !== undefined) {
      const shared = this.byKey.get(key);
      if (shared) return shared.promise as Promise<T>;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const entry: Entry = { kind, root, rootKeys: [root, ...(opts.alsoRoots ?? [])].map(canonicalProjectRoot), coalesceKey: key, run, resolve, reject, promise };
    if (key !== undefined) this.byKey.set(key, entry);
    (jobLane(kind) === 'cold' ? this.coldJobs : this.syncJobs).push(entry);
    this.pump();
    return promise as Promise<T>;
  }

  /** The jobs running now, at most one per lane, by ascending id. `id` tells one run from the next (./job-watchdog.ts times each from its first sight). */
  runningJobs(): RunningJob[] {
    return [...this.running].sort(([, a], [, b]) => a.id - b.id)
      .map(([lane, { entry, id }]) => ({ id, kind: entry.kind, root: entry.root, lane }));
  }

  /** How many jobs wait, by lane (the running ones are not counted). */
  waiting(): { sync: number; cold: number } {
    return { sync: this.syncJobs.length, cold: this.coldJobs.length };
  }

  /** Resolves when no job runs in either lane and none waits. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Resolves when no job of `root` (any spelling of it: the canonical root is compared) runs or waits; at once
   * when none does. A job counts for its own root and for each of its {@link EnqueueOptions.alsoRoots}. It looks
   * only at jobs that name `root`, never at those of other roots. Jobs queued for the root while
   * this waits are waited for too: it resolves at the first moment the root has none. A closed queue holds
   * no waiting job, so the running ones are the last this waits for.
   */
  whenRootIdle(root: string): Promise<void> {
    const rootKey = canonicalProjectRoot(root);
    if (!this.hasJobOf(rootKey)) return Promise.resolve();
    return new Promise((resolve) => this.rootWaiters.push({ rootKey, resolve }));
  }

  /**
   * Stop taking jobs and reject every one still waiting (a stopping builder). The running jobs are left to
   * finish: resolves once both lanes' have.
   */
  async close(): Promise<void> {
    this.closed = true;
    const dropped = [...this.syncJobs.splice(0), ...this.coldJobs.splice(0)];
    this.byKey.clear();
    for (const entry of dropped) entry.reject(new Error('the index builder is stopping'));
    this.settleRootWaiters();
    await this.whenIdle();
  }

  /**
   * Start what the writer rule allows, the sync lane first, then the cold lane's head; resolve the
   * {@link whenIdle} callers when nothing is left. Runs inside {@link enqueue} and after each job ends.
   */
  private pump(): void {
    const busy = new Set([...this.running.values()].flatMap(({ entry }) => entry.rootKeys));
    // The cold head also waits for every waiting sync job of its roots, the one about to start included.
    const coldBlockers = new Set([...busy, ...this.syncJobs.flatMap((entry) => entry.rootKeys)]);
    const at = this.running.has('sync') ? -1 : firstStartable(this.syncJobs, busy);
    const sync = at === -1 ? undefined : this.syncJobs[at];
    if (sync !== undefined) {
      this.syncJobs.splice(at, 1);
      this.start(sync, 'sync');
    }
    const cold = this.coldJobs[0];
    if (cold !== undefined && !this.running.has('cold') && firstStartable([cold], coldBlockers) === 0) {
      this.coldJobs.shift();
      this.start(cold, 'cold');
    }
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private isIdle(): boolean {
    return this.running.size === 0 && this.syncJobs.length === 0 && this.coldJobs.length === 0;
  }

  private start(next: Entry, lane: JobLane): void {
    if (next.coalesceKey !== undefined && this.byKey.get(next.coalesceKey) === next) this.byKey.delete(next.coalesceKey);
    this.lastId += 1;
    this.running.set(lane, { entry: next, id: this.lastId });
    this.emit({ edge: 'start', kind: next.kind, root: next.root });
    // `run` may throw before its first await; the async wrapper turns that into a rejection too.
    void (async () => next.run())().then(
      (value) => {
        if (next.kind === 'init' || next.kind === 'index') endedJobs.clearRoot(next.root);
        this.emit({ edge: 'end', kind: next.kind, root: next.root, ok: true });
        this.running.delete(lane);
        next.resolve(value);
        this.pump();
        this.settleRootWaiters();
      },
      (err: unknown) => {
        this.emit({ edge: 'end', kind: next.kind, root: next.root, ok: false, error: oneLine(err) });
        this.running.delete(lane);
        next.reject(err);
        this.pump();
        this.settleRootWaiters();
      },
    );
  }

  /** A job of the root with this canonical key runs or waits. */
  private hasJobOf(rootKey: string): boolean {
    return [...this.running.values()].some(({ entry }) => entry.rootKeys.includes(rootKey))
      || this.syncJobs.some((e) => e.rootKeys.includes(rootKey))
      || this.coldJobs.some((e) => e.rootKeys.includes(rootKey));
  }

  /**
   * Resolve the {@link whenRootIdle} callers whose root has no job now. Run after a job settles (its own
   * promise is settled first, so a caller sees the job's reply before the idle) and after the queue dropped its waiting jobs.
   */
  private settleRootWaiters(): void {
    if (this.rootWaiters.length === 0) return;
    const still: Array<{ rootKey: string; resolve: () => void }> = [];
    for (const waiter of this.rootWaiters) {
      if (this.hasJobOf(waiter.rootKey)) still.push(waiter);
      else waiter.resolve();
    }
    this.rootWaiters = still;
  }

  private emit(event: JobEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* a failing log never fails a job */
    }
  }
}
