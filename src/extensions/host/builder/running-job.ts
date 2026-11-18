/**
 * A builder job that runs now, as the queue (./queue.ts) reports it to the watchdog (./job-watchdog.ts) and the
 * fences (./fences.ts). `repo` is the repository key it was queued under (./repo-key-by-stat.ts), and `lane` the
 * slot it holds (./job-lane-type.ts): its repository's own, or a shared bypass slot. `id` tells one run from the
 * next: one counter across every slot.
 */
import type { JobLane } from './job-lane-type';
import type { JobKind } from './queue';

export interface RunningJob {
  id: number;
  kind: JobKind;
  root: string;
  repo: string;
  lane: JobLane;
}
