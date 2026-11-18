/**
 * The index builder's job queue: one lane per git repository, plus two bypass slots any repository may use
 * (R-53). A job's repository is taken once, when it is queued (`repoOf`, by default ./repo-key-by-stat.ts: the
 * worktrees of one repository share its lane).
 *
 * Each repository runs one job at a time in its own slot, and different repositories run at once. Within a
 * repository the short jobs (`sync`, `catch-up`, `watch-sync`, `seed`, `recover`, `open`: a changed file or two,
 * a copy of an index, the writable open of one) go ahead of its whole-repository jobs (`cold-build`, the CLI's
 * `init` and `index`, ./cli-jobs.ts, and the VACUUM a job's end queues, ./vacuum-after-job.ts), which run for
 * minutes and start oldest first. While a repository's own slot is busy, its next job may start in a free bypass
 * slot when the machine's load average is below the limit at that start; ./next-start.ts makes the pick.
 *
 * One writer per root: a job starts only when none of its roots (its own and its `alsoRoots`) is a root of a
 * running job in any slot. The pick is first-eligible (./first-startable.ts): a later job of a root can start
 * before an earlier waiting job that names it among other roots, and a root's short jobs go before its
 * whole-repository job only while that job still waits. The queue never preempts a running job. A job over its
 * limit is ended by ./job-limit-guard.ts: its child process (./job-supervisor.ts) is killed, and the builder and
 * the other jobs go on.
 *
 * {@link JobQueue.whenRootIdle} tells when no job of one root runs or waits (the release of an index being
 * removed waits on it, ./cli-relay.ts); the jobs are keyed by the root's canonical spelling.
 *
 * Every job is logged as it starts and ends, through `onEvent`; the builder writes those as the lines of
 * `<state dir>/builder.log`.
 *
 * A job ended over a limit (./job-limit-guard.ts) is refused here afterwards: a later enqueue of the same root
 * and kind rejects with {@link JobEndedError} (./ended-jobs.ts holds the marks). So a `vacuum` ended over a
 * limit is not queued again for its root until an explicit `init` or `index` of it. Cold builds are refused by
 * the builder before their child starts instead (cold-build-job.ts), and `init` and `index` never are: they are the explicit way to try
 * again, and one that ends ok clears its root's marks.
 */
import * as os from 'os';
import { canonicalProjectRoot } from '../../../directory';
import { endedJobs } from './ended-jobs';
import { JobEndedError } from './job-ended-error';
import type { JobLane } from './job-lane-type';
import { nextStart } from './next-start';
import { repoKeyByStat } from './repo-key-by-stat';
import type { RunningJob } from './running-job';

/**
 * What a job does, and so whether it goes ahead of its repository's long jobs (./is-whole-repository-job.ts).
 * `sync` is a caller's sync (the server's, or the CLI's `sync`); `init` and `index` are the CLI's
 * whole-repository index writes (./cli-jobs.ts); `vacuum` is the VACUUM of one root's index (./vacuum-after-job.ts).
 */
export type JobKind = 'sync' | 'catch-up' | 'watch-sync' | 'seed' | 'cold-build' | 'init' | 'index' | 'recover' | 'open' | 'vacuum';

/** The kinds an ended mark never refuses at enqueue: `init` and `index` are the explicit retry; a cold build is refused before its child starts (cold-build-job.ts). */
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
  /** The repository key of a root, taken once when its job is queued; default ./repo-key-by-stat.ts. */
  repoOf?: (root: string) => string;
  /** The machine's 1-minute load average, read when a job would start in a bypass slot; default `os.loadavg()[0]`. */
  loadAverage?: () => number;
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
  /** Set when the job starts (./running-job.ts); 0 while it waits. */
  id: number;
  kind: JobKind;
  root: string;
  /** The repository key of `root` ({@link JobQueueOptions.repoOf}), taken when the job was queued. */
  repo: string;
  /** `root` and its {@link EnqueueOptions.alsoRoots} in their canonical spelling, taken when the job was queued; what {@link JobQueue.whenRootIdle} matches. */
  rootKeys: readonly string[];
  coalesceKey: string | undefined;
  run: (job: { id: number }) => Promise<unknown>;
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
  /** The jobs not started yet, in the order they were queued. */
  private readonly waitingJobs: Entry[] = [];
  /** Queued, not started, entries by coalesce key. */
  private readonly byKey = new Map<string, Entry>();
  /** The jobs running now with the slot each holds, by ascending id. */
  private readonly running: Array<{ job: Entry; lane: JobLane }> = [];
  /** The id of the job started last, in any slot: 1 for the first, one more for each next. */
  private lastId = 0;
  private readonly repoOf: (root: string) => string;
  private readonly loadAverage: () => number;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  /** Callers of {@link whenRootIdle}, by the canonical root they wait on. */
  private rootWaiters: Array<{ rootKey: string; resolve: () => void }> = [];

  constructor(private readonly options: JobQueueOptions = {}) {
    this.repoOf = options.repoOf ?? repoKeyByStat;
    this.loadAverage = options.loadAverage ?? (() => os.loadavg()[0] ?? 0);
  }

  /**
   * Queue a job. Resolves with `run`'s value, rejects with its error (the failure is logged as well). A
   * closed queue rejects at once, and so does a root and kind ended over a limit (a {@link JobEndedError},
   * with no run and no log line), except the {@link NEVER_REFUSED} kinds. An `init` or `index` that ends ok
   * clears its root's ended marks. `run` is called with an object holding the job's `id`, the one {@link JobQueue.runningJobs} reports.
   */
  enqueue<T>(kind: JobKind, root: string, run: (job: { id: number }) => Promise<T>, opts: EnqueueOptions = {}): Promise<T> {
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
    const rootKeys = [root, ...(opts.alsoRoots ?? [])].map(canonicalProjectRoot);
    const entry: Entry = { id: 0, kind, root, repo: this.repoOf(root), rootKeys, coalesceKey: key, run, resolve, reject, promise };
    if (key !== undefined) this.byKey.set(key, entry);
    this.waitingJobs.push(entry);
    this.pump();
    return promise as Promise<T>;
  }

  /**
   * The jobs running now, by ascending id: at most one per repository in its own slot, and up to two more in the
   * bypass slots. `id` tells one run from the next (./job-watchdog.ts times each from its first sight).
   */
  runningJobs(): RunningJob[] {
    return this.running.map(({ job: { id, kind, root, repo }, lane }) => ({ id, kind, root, repo, lane }));
  }

  /** How many jobs wait, across every repository (the running ones are not counted). */
  waiting(): number {
    return this.waitingJobs.length;
  }

  /** Resolves when no job runs in any slot and none waits. */
  whenIdle(): Promise<void> {
    // pump() has already started every job it can, so here it only resolves the waiters if nothing is left.
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.pump();
    });
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
   * finish: resolves once every slot's have.
   */
  async close(): Promise<void> {
    this.closed = true;
    const dropped = this.waitingJobs.splice(0);
    this.byKey.clear();
    for (const entry of dropped) entry.reject(new Error('the index builder is stopping'));
    this.settleRootWaiters();
    await this.whenIdle();
  }

  /**
   * Start each job the pick allows (./next-start.ts), one at a time; resolve the {@link whenIdle} callers when
   * nothing is left. Runs inside {@link enqueue}, {@link whenIdle} and after each job ends; there is no timer, so
   * a job held back by the load waits for the next of those. The pick is taken again after every start: a job's
   * `run` can enqueue, and so pump, before its first await.
   */
  private pump(): void {
    for (;;) {
      const next = nextStart(this.waitingJobs, this.running, this.loadAverage);
      if (next === null) break;
      for (const entry of this.waitingJobs.splice(next.index, 1)) {
        if (entry.coalesceKey !== undefined && this.byKey.get(entry.coalesceKey) === entry) this.byKey.delete(entry.coalesceKey);
        this.lastId += 1;
        entry.id = this.lastId;
        const slot = { job: entry, lane: next.lane };
        this.running.push(slot);
        this.emit({ edge: 'start', kind: entry.kind, root: entry.root });
        // `run` may throw before its first await; the async wrapper turns that into a rejection too.
        void (async () => entry.run({ id: entry.id }))().then(
          (value) => {
            if (entry.kind === 'init' || entry.kind === 'index') endedJobs.clearRoot(entry.root);
            this.emit({ edge: 'end', kind: entry.kind, root: entry.root, ok: true });
            this.running.splice(this.running.indexOf(slot), 1);
            entry.resolve(value);
            this.pump();
            this.settleRootWaiters();
          },
          (err: unknown) => {
            this.emit({ edge: 'end', kind: entry.kind, root: entry.root, ok: false, error: oneLine(err) });
            this.running.splice(this.running.indexOf(slot), 1);
            entry.reject(err);
            this.pump();
            this.settleRootWaiters();
          },
        );
      }
    }
    if (this.running.length + this.waitingJobs.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** A job of the root with this canonical key runs or waits. */
  private hasJobOf(rootKey: string): boolean {
    return [...this.running.map(({ job }) => job), ...this.waitingJobs].some((e) => e.rootKeys.includes(rootKey));
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
