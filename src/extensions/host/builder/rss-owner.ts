/**
 * Which running job the builder's resident size is charged to (./job-watchdog.ts). RSS is one figure for the
 * whole process, and with two lanes two jobs share it. The cold-lane job holds a whole repository's parse state
 * while a sync job touches a few files, so an RSS breach is charged to the cold-lane job when one runs. This is a
 * heuristic: a sync job that grows the heap past the limit beside a cold build gets the cold build marked.
 */
import type { RunningJob } from './running-job';

/** The cold-lane job if one runs, else the first job; null when none runs. */
export function rssOwner(jobs: readonly RunningJob[]): RunningJob | null {
  return jobs.find((job) => job.lane === 'cold') ?? jobs[0] ?? null;
}
