/**
 * The index builder's job queue: one job runs at a time, in two priority classes.
 *
 * SYNC jobs (`sync`, `catch-up`, `watch-sync`, `seed`, `recover`, `open`) are short: a changed file or two, a
 * copy of an index, the writable open of one (its migrations and repairs). COLD jobs (`cold-build`) index a whole repository and run for minutes. A SYNC job always starts
 * before any queued COLD job, so an agent's edit becomes visible without waiting behind the cold builds
 * queued ahead of it. Within a class the order is first in, first out. A running job is never preempted:
 * nothing here can interrupt an index run halfway, so a SYNC job that arrives while a cold build runs waits
 * for that one build to end, and then goes before the next.
 *
 * Every job is logged as it starts and ends, through `onEvent`; the builder writes those as the lines of
 * `<state dir>/builder.log`.
 */

/** What a job does, and so which class it is in. */
export type JobKind = 'sync' | 'catch-up' | 'watch-sync' | 'seed' | 'cold-build' | 'recover' | 'open';

/** The kinds that wait behind every queued SYNC job. */
const COLD_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['cold-build']);

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
}

interface Entry {
  kind: JobKind;
  root: string;
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
  private running: Entry | null = null;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: JobQueueOptions = {}) {}

  /**
   * Queue a job. Resolves with `run`'s value, rejects with its error (the failure is logged as well). A
   * closed queue rejects at once.
   */
  enqueue<T>(kind: JobKind, root: string, run: () => Promise<T>, opts: EnqueueOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the index builder is stopping'));
    const key = opts.coalesceKey;
    if (key !== undefined) {
      const shared = this.byKey.get(key);
      if (shared) return shared.promise as Promise<T>;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const entry: Entry = { kind, root, coalesceKey: key, run, resolve, reject, promise };
    if (key !== undefined) this.byKey.set(key, entry);
    (COLD_KINDS.has(kind) ? this.coldJobs : this.syncJobs).push(entry);
    this.pump();
    return promise as Promise<T>;
  }

  /** The job running now, or null. */
  runningJob(): { kind: JobKind; root: string } | null {
    return this.running ? { kind: this.running.kind, root: this.running.root } : null;
  }

  /** How many jobs wait, by class (the running one is not counted). */
  waiting(): { sync: number; cold: number } {
    return { sync: this.syncJobs.length, cold: this.coldJobs.length };
  }

  /** Resolves when no job runs and none waits. */
  whenIdle(): Promise<void> {
    if (this.running === null && this.syncJobs.length === 0 && this.coldJobs.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Stop taking jobs and reject every one still waiting (a stopping builder). The running job is left to
   * finish: resolves once it has.
   */
  async close(): Promise<void> {
    this.closed = true;
    const dropped = [...this.syncJobs.splice(0), ...this.coldJobs.splice(0)];
    this.byKey.clear();
    for (const entry of dropped) entry.reject(new Error('the index builder is stopping'));
    await this.whenIdle();
  }

  private pump(): void {
    if (this.running !== null) return;
    const next = this.syncJobs.shift() ?? this.coldJobs.shift();
    if (next === undefined) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
      return;
    }
    if (next.coalesceKey !== undefined && this.byKey.get(next.coalesceKey) === next) this.byKey.delete(next.coalesceKey);
    this.running = next;
    this.emit({ edge: 'start', kind: next.kind, root: next.root });
    // `run` may throw before its first await; the async wrapper turns that into a rejection too.
    void (async () => next.run())().then(
      (value) => {
        this.emit({ edge: 'end', kind: next.kind, root: next.root, ok: true });
        this.running = null;
        next.resolve(value);
        this.pump();
      },
      (err: unknown) => {
        this.emit({ edge: 'end', kind: next.kind, root: next.root, ok: false, error: oneLine(err) });
        this.running = null;
        next.reject(err);
        this.pump();
      },
    );
  }

  private emit(event: JobEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* a failing log never fails a job */
    }
  }
}
