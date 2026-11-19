/** What the VACUUM after a job (./vacuum-after-job.ts) needs from the builder, and its test seams. */
import type { DbPageStats } from './db-page-stats-type';
import type { JobRunner } from './job-runner-type';
import type { JobQueue } from './queue';

export interface VacuumAfterJobDeps {
  queue: Pick<JobQueue, 'enqueue'>;
  /** One line for the builder's job log. */
  jobLog(line: string): void;
  /** Whether a rebuild keeps the builder's writers off the root (./fences.ts rebuildHeld). */
  rebuildHeld(root: string): boolean;
  /** Runs the VACUUM's body (./vacuum-job.ts) in the job's own child process (./job-runner-type.ts). */
  runJob: JobRunner;
  /** Test seams; the defaults are the real page stats and the 256 MiB floor. */
  readStats?: (dbPath: string) => DbPageStats | null;
  minFreelistBytes?: number;
}
