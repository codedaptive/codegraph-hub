/**
 * Samples the builder's running job against its limits (./job-limits.ts). Jobs run in the builder's own process,
 * so the only way to end one over a limit is to end the process (./job-limit-guard.ts, through `onBreach`); this
 * only decides when. A job's time is measured from the first check that saw it running, so it can be up to one
 * interval late (and later while a job blocks the event loop, since the sample runs on the main thread); the resident size
 * is the whole builder process's, which is the job's while it is the one running.
 */
import { checkJobLimits, type LimitBreach } from './job-limit-breach';
import type { JobLimits } from './job-limits';
import type { JobKind, JobQueue } from './queue';

/** Five seconds: a job over its limit is caught within one interval once the event loop turns, and a sample costs next to nothing. */
const DEFAULT_INTERVAL_MS = 5000;

export interface JobWatchdogOptions {
  clock?: () => number;
  readRssBytes?: () => number;
  intervalMs?: number;
  onBreach: (job: { id: number; kind: JobKind; root: string }, breach: LimitBreach) => void;
}

export class JobWatchdog {
  private seenId: number | null = null;
  private startedAt = 0;
  private breachedId: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;
  private readonly readRssBytes: () => number;

  constructor(
    private readonly queue: Pick<JobQueue, 'runningJob'>,
    private readonly limits: JobLimits,
    private readonly opts: JobWatchdogOptions,
  ) {
    this.clock = opts.clock ?? Date.now;
    this.readRssBytes = opts.readRssBytes ?? (() => process.memoryUsage.rss());
  }

  /** One sample: a running job over a limit is reported through `onBreach`, once per job. */
  check(): void {
    const job = this.queue.runningJob();
    if (job === null) return;
    if (job.id !== this.seenId) {
      this.seenId = job.id;
      this.startedAt = this.clock();
    }
    if (job.id === this.breachedId) return;
    const breach = checkJobLimits(this.clock() - this.startedAt, this.readRssBytes(), this.limits);
    if (breach === null) return;
    this.breachedId = job.id;
    this.opts.onBreach(job, breach);
  }

  /** Sample every `intervalMs` without keeping the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch {
        // A failed sample is skipped; the next one looks again.
      }
    }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
