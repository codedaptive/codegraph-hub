/**
 * Samples the builder's running jobs, at most one per lane, against their limits (./job-limits.ts). Jobs run in
 * the builder's own process, so the only way to end one over a limit is to end the process
 * (./job-limit-guard.ts, through `onBreach`); this only decides when, and which job is over. Each job's time is
 * measured from the first check that saw it running, so it can be up to one interval late (and later while a job
 * blocks the event loop, since the sample runs on the main thread). The resident size is the whole builder
 * process's, read once per check and charged to one job (./rss-owner.ts); the other job is judged on time alone.
 */
import { checkJobLimits } from './job-limit-breach';
import type { JobLimits } from './job-limits-type';
import type { LimitBreach } from './limit-breach';
import type { JobQueue } from './queue';
import { rssOwner } from './rss-owner';
import type { RunningJob } from './running-job';

/** Five seconds: a job over its limit is caught within one interval once the event loop turns, and a sample costs next to nothing. */
const DEFAULT_INTERVAL_MS = 5000;

interface JobWatchdogOptions {
  clock?: () => number;
  readRssBytes?: () => number;
  intervalMs?: number;
  onBreach: (job: RunningJob, breach: LimitBreach) => void;
}

export class JobWatchdog {
  /** The clock reading at the first check that saw each running job; ids no longer running are forgotten. */
  private readonly startedAt = new Map<number, number>();
  private readonly breached = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;
  private readonly readRssBytes: () => number;

  constructor(
    private readonly queue: Pick<JobQueue, 'runningJobs'>,
    private readonly limits: JobLimits,
    private readonly opts: JobWatchdogOptions,
  ) {
    this.clock = opts.clock ?? Date.now;
    this.readRssBytes = opts.readRssBytes ?? (() => process.memoryUsage.rss());
  }

  /**
   * One sample: the first job over a limit in ascending id (the older job first) is reported through `onBreach`,
   * and the sample ends there; no job is reported twice.
   */
  check(): void {
    const jobs = [...this.queue.runningJobs()].sort((a, b) => a.id - b.id);
    this.forgetEnded(jobs);
    if (jobs.length === 0) return;
    const now = this.clock();
    for (const job of jobs) if (!this.startedAt.has(job.id)) this.startedAt.set(job.id, now);
    const rss = this.readRssBytes();
    const owner = rssOwner(jobs);
    for (const job of jobs) {
      if (this.breached.has(job.id)) continue;
      const breach = checkJobLimits(now - (this.startedAt.get(job.id) ?? now), job === owner ? rss : 0, this.limits);
      if (breach === null) continue;
      this.breached.add(job.id);
      this.opts.onBreach(job, breach);
      return;
    }
  }

  private forgetEnded(jobs: readonly RunningJob[]): void {
    const running = new Set(jobs.map((job) => job.id));
    for (const id of this.startedAt.keys()) if (!running.has(id)) this.startedAt.delete(id);
    for (const id of this.breached) if (!running.has(id)) this.breached.delete(id);
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
