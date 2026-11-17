/**
 * Which of the builder queue's two lanes (./queue.ts) a job kind runs in. The whole-repository writes
 * (`cold-build`, and the CLI's `init` and `index`, ./cli-jobs.ts) run for minutes and go to the `cold` lane;
 * every other kind is short and goes to the `sync` lane, which runs beside it.
 */
import type { JobKind } from './queue';
import type { JobLane } from './running-job';

export function jobLane(kind: JobKind): JobLane {
  return kind === 'cold-build' || kind === 'init' || kind === 'index' ? 'cold' : 'sync';
}
