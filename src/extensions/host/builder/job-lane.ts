/**
 * Which of the builder queue's two lanes (./queue.ts) a job kind runs in. The whole-repository writes
 * (`cold-build`, and the CLI's `init` and `index`, ./cli-jobs.ts) and the VACUUM of a root's index (`vacuum`,
 * ./vacuum-after-job.ts; R-45) run for minutes and go to the `cold` lane, so a VACUUM never holds up a sync;
 * every other kind is short and goes to the `sync` lane, which runs beside it.
 */
import type { JobKind } from './queue';
import type { JobLane } from './job-lane-type';

export function jobLane(kind: JobKind): JobLane {
  return kind === 'cold-build' || kind === 'init' || kind === 'index' || kind === 'vacuum' ? 'cold' : 'sync';
}
