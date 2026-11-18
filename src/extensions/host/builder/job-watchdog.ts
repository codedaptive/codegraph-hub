/**
 * Samples the builder's running jobs, one per busy repository slot and bypass slot, against their limits
 * (./job-limits.ts), and reports the first job over one through `onBreach` (./job-limit-guard.ts ends it); this
 * only decides when, and which job is over. Every job runs in its own child process (./job-supervisor.ts), and is
 * judged on that child's resident size, read from outside (`readChildRssBytes`, ./read-process-rss.ts); when the
 * read fails, on time alone. A job's time is measured from the first check that saw it running, so it can be up to
 * one interval late (and later while the builder's event loop is blocked, since the sample runs on its main
 * thread). A job with no child at the check (its builder-side checks before the child starts, or a cold build's
 * delay between attempts) is not judged, but its time still counts from that first sight. A sample reads the
 * children's sizes asynchronously, and a check that comes while one is still reading is skipped. A size is judged
 * only if, once read, its job still runs in the child it was read from: a job whose child closed or was replaced
 * (a cold build's retry) during the read is dropped unjudged, and the next check samples its current child.
 */
import { checkJobLimits } from './job-limit-breach';
import type { JobLimits } from './job-limits-type';
import type { LimitBreach } from './limit-breach';
import type { JobQueue } from './queue';
import { readProcessRssBytes } from './read-process-rss';
import type { RunningJob } from './running-job';

/** Five seconds: a job over its limit is caught within one interval once the event loop turns, and a sample costs next to nothing. */
const DEFAULT_INTERVAL_MS = 5000;

interface JobWatchdogOptions {
  clock?: () => number;
  /** The pid of the child job `jobId` runs in; null while it has none. */
  childPid: (jobId: number) => number | null;
  readChildRssBytes?: (pid: number) => Promise<number | null>;
  intervalMs?: number;
  /** `childPid` is the pid of the child the job was sampled in, and still runs in after the read. */
  onBreach: (job: RunningJob, breach: LimitBreach, childPid: number) => void;
}

export class JobWatchdog {
  /** The clock reading at the first check that saw each running job; ids no longer running are forgotten. */
  private readonly startedAt = new Map<number, number>();
  private readonly breached = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private readonly clock: () => number;
  private readonly readChildRssBytes: (pid: number) => Promise<number | null>;

  constructor(
    private readonly queue: Pick<JobQueue, 'runningJobs'>,
    private readonly limits: JobLimits,
    private readonly opts: JobWatchdogOptions,
  ) {
    this.clock = opts.clock ?? Date.now;
    this.readChildRssBytes = opts.readChildRssBytes ?? readProcessRssBytes;
  }

  /**
   * One sample: once the children's sizes are read, the first job over a limit in ascending id (the older job
   * first) is reported through `onBreach`, and the sample ends there; no job is reported twice, and a job that
   * ended, or whose child is no longer the one read, meanwhile is skipped without being marked reported.
   */
  check(): Promise<void> {
    if (this.sampling) return Promise.resolve();
    const jobs = [...this.queue.runningJobs()].sort((a, b) => a.id - b.id);
    this.forgetEnded(jobs);
    const now = this.clock();
    for (const job of jobs) if (!this.startedAt.has(job.id)) this.startedAt.set(job.id, now);
    const pending = jobs.flatMap((job) => {
      const pid = this.opts.childPid(job.id);
      return pid === null || this.breached.has(job.id) ? [] : [{ job, pid }];
    });
    if (pending.length === 0) return Promise.resolve();
    this.sampling = true;
    return Promise.all(pending.map(async ({ job, pid }) => ({ job, pid, rss: await this.readChildRssBytes(pid) })))
      .then((sized) => {
        const still = new Set(this.queue.runningJobs().map((job) => job.id));
        this.judge(now, sized.filter(({ job, pid }) => still.has(job.id) && this.opts.childPid(job.id) === pid));
      })
      .finally(() => { this.sampling = false; });
  }

  /**
   * Report the first of `jobs` (each still running in child `pid`) over a limit at `now`; a null `rss` (a child's
   * size that could not be read) judges time only.
   */
  private judge(now: number, jobs: readonly { job: RunningJob; pid: number; rss: number | null }[]): void {
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
