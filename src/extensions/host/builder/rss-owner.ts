/**
 * Which running job the builder's resident size is charged to (./job-watchdog.ts). RSS is one figure for the
 * whole process, shared by every job running in it. A whole-repository job (./is-whole-repository-job.ts) holds a
 * repository's parse state while a short job touches a few files, so an RSS breach is charged to the oldest
 * running whole-repository job when one runs, else to the oldest job. This is a heuristic: a short job that grows
 * the heap past the limit beside a cold build gets the cold build marked, and of two whole-repository jobs the
 * older is charged whichever one grew.
 */
import { isWholeRepositoryJob } from './is-whole-repository-job';
import type { RunningJob } from './running-job';

/** The lowest-id whole-repository job if one runs, else the lowest-id job; null when none runs. */
export function rssOwner(jobs: readonly RunningJob[]): RunningJob | null {
  const byId = [...jobs].sort((a, b) => a.id - b.id);
  return byId.find((job) => isWholeRepositoryJob(job.kind)) ?? byId[0] ?? null;
}
