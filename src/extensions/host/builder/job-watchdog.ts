/**
 * Samples the builder's running jobs, one per busy repository slot and bypass slot, against their limits
 * (./job-limits.ts), and reports the first job over one through `onBreach` (./job-limit-guard.ts ends it); this
 * only decides when, and which job is over. Each job's time is measured from the first check that saw it running,
 * so it can be up to one interval late (and later while the builder's event loop is blocked, since the sample
 * runs on its main thread).
 *
 * A job that runs in its own child process (`childPid`, ./job-supervisor.ts) is judged on that child's resident
 * size, read from outside (`readChildRssBytes`, ./read-process-rss.ts); when the read fails, on time alone. The
 * jobs still running in the builder's process share its one resident size, charged to one of them
 * (./rss-owner.ts); the others are judged on time alone. A sample reads the children's sizes asynchronously, and
 * a check that comes while one is still reading is skipped.
 */
import { checkJobLimits } from './job-limit-breach';
import type { JobLimits } from './job-limits-type';
import type { LimitBreach } from './limit-breach';
import type { JobQueue } from './queue';
import { readProcessRssBytes } from './read-process-rss';
import { rssOwner } from './rss-owner';
import type { RunningJob } from './running-job';

/** Five seconds: a job over its limit is caught within one interval once the event loop turns, and a sample costs next to nothing. */
const DEFAULT_INTERVAL_MS = 5000;

interface JobWatchdogOptions {
  clock?: () => number;
  /** The builder process's own resident size. */
  readRssBytes?: () => number;
  /** The pid of the child a job runs in; null for a job in the builder's process. Default: none has one. */
  childPid?: (jobId: number) => number | null;
  readChildRssBytes?: (pid: number) => Promise<number | null>;
  intervalMs?: number;
  /** `childPid` is the pid of the job's child at the sample, null for a job in the builder's process. */
  onBreach: (job: RunningJob, breach: LimitBreach, childPid: number | null) => void;
}

export class JobWatchdog {
  /** The clock reading at the first check that saw each running job; ids no longer running are forgotten. */
  private readonly startedAt = new Map<number, number>();
  private readonly breached = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private readonly clock: () => number;
  private readonly readRssBytes: () => number;
  private readonly childPid: (jobId: number) => number | null;
  private readonly readChildRssBytes: (pid: number) => Promise<number | null>;

  constructor(
    private readonly queue: Pick<JobQueue, 'runningJobs'>,
    private readonly limits: JobLimits,
    private readonly opts: JobWatchdogOptions,
  ) {
    this.clock = opts.clock ?? Date.now;
    this.readRssBytes = opts.readRssBytes ?? (() => process.memoryUsage.rss());
    this.childPid = opts.childPid ?? (() => null);
    this.readChildRssBytes = opts.readChildRssBytes ?? readProcessRssBytes;
  }

  /**
   * One sample: the first job over a limit in ascending id (the older job first) is reported through `onBreach`,
   * and the sample ends there; no job is reported twice. With no job in a child, the sample is judged before this
   * returns. Otherwise it is judged once the children's sizes are read, skipping a job that ended meanwhile.
   */
  check(): Promise<void> {
    if (this.sampling) return Promise.resolve();
    const jobs = [...this.queue.runningJobs()].sort((a, b) => a.id - b.id);
    this.forgetEnded(jobs);
    if (jobs.length === 0) return Promise.resolve();
    const now = this.clock();
    for (const job of jobs) if (!this.startedAt.has(job.id)) this.startedAt.set(job.id, now);
    const withPid = jobs.map((job) => ({ job, pid: this.childPid(job.id) }));
    const owner = rssOwner(withPid.filter(({ pid }) => pid === null).map(({ job }) => job));
    const builderRss = owner === null ? 0 : this.readRssBytes();
    const pending = withPid.filter(({ job }) => !this.breached.has(job.id));
    const inBuilder = (job: RunningJob): number => (job === owner ? builderRss : 0);
    if (pending.every(({ pid }) => pid === null)) {
      try {
        this.judge(now, pending.map((entry) => ({ ...entry, rss: inBuilder(entry.job) })));
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    }
    this.sampling = true;
    return Promise.all(pending.map(async ({ job, pid }) => ({ job, pid, rss: pid === null ? inBuilder(job) : await this.readChildRssBytes(pid) })))
      .then((sized) => {
        const still = new Set(this.queue.runningJobs().map((job) => job.id));
        this.judge(now, sized.filter(({ job }) => still.has(job.id)));
      })
      .finally(() => { this.sampling = false; });
  }

  /** Report the first of `jobs` over a limit at `now`; a null `rss` (a child's size that could not be read) judges time only. */
  private judge(now: number, jobs: readonly { job: RunningJob; pid: number | null; rss: number | null }[]): void {
    for (const { job, pid, rss } of jobs) {
      const breach = checkJobLimits(now - (this.startedAt.get(job.id) ?? now), rss ?? 0, this.limits);
      if (breach === null) continue;
      this.breached.add(job.id);
      this.opts.onBreach(job, breach, pid);
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
      // A failed sample is skipped; the next one looks again.
      this.check().catch(() => undefined);
    }, this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
