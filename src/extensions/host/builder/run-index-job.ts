/**
 * The builder's side of the CLI's `init` and `index` jobs: run ./index-root-body.ts for job `jobId` through
 * `runJob` and turn its payloads into the request's events, in order: a `{log: line}` payload is a `log` event,
 * any other is the engine's progress. For `open: 'init'`, the `initialized` event the CLI waits for goes out
 * before the first payload, or before the result when the body sent none: the body sends nothing until
 * CodeGraph.init has returned, so either one means the init is done. A body that fails before any payload sends
 * no `initialized`, and the CLI gets the error. The body's error rejects as the runner gave it, its name with
 * it, so the CLI learns the error's name (./cli-relay.ts sends it as `errorName`).
 */
import type { IndexProgress, IndexResult } from '../../../extraction';
import type { IndexWriteEvent } from './cli-wire';
import { jobBodySpec } from './job-body-spec';
import type { JobRunner } from './job-runner-type';
import { progressLogLine } from './progress-log-line';

export async function runIndexJob(
  runJob: JobRunner,
  jobId: number,
  args: { root: string; open: 'init' | 'recreate' | 'open'; verbose: boolean },
  emit: (event: IndexWriteEvent) => void,
): Promise<IndexResult> {
  let initialized = args.open !== 'init';
  const announce = (): void => {
    if (initialized) return;
    initialized = true;
    emit({ kind: 'initialized' });
  };
  const spec = jobBodySpec(args.open === 'init' ? 'init' : 'index', args.root, 'index-root-body', 'indexRootBody', args);
  const result = await runJob(jobId, spec, (payload) => {
    announce();
    const line = progressLogLine(payload);
    if (line !== null) {
      emit({ kind: 'log', line });
    } else {
      emit({ kind: 'progress', progress: payload as IndexProgress });
    }
  });
  announce();
  return result as IndexResult;
}
