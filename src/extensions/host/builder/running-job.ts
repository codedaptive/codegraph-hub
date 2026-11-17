/**
 * A builder job that runs now, as the queue (./queue.ts) reports it to the watchdog (./job-watchdog.ts) and the
 * fences (./fences.ts). The builder has two lanes (R-43): `cold` runs the whole-repository writes (`cold-build`,
 * `init`, `index`) one at a time, and `sync` runs every other kind beside it, so a sync of an indexed root never
 * waits for another root's cold build. `id` tells one run from the next: one counter across both lanes.
 */
import type { JobKind } from './queue';

export type JobLane = 'sync' | 'cold';

export interface RunningJob {
  id: number;
  kind: JobKind;
  root: string;
  lane: JobLane;
}
