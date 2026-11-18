/**
 * The builder's side of a sync job: run ./sync-root-body.ts for job `jobId` of `kind` on `root` through
 * `runJob`, with `paths` when the sync is scoped to them, and answer its SyncResult. A `locked` answer is thrown
 * as the LockUnavailableError the body caught (./sync-job-outcome-type.ts). `onProgress` gets the engine's
 * progress in order.
 */
import type { IndexProgress, SyncResult } from '../../../extraction';
import { LockUnavailableError } from '../../../errors';
import { jobBodySpec } from './job-body-spec';
import type { JobRunner } from './job-runner-type';
import type { JobKind } from './queue';
import type { SyncJobOutcome } from './sync-job-outcome-type';

export async function runSyncJob(
  runJob: JobRunner,
  jobId: number,
  kind: JobKind,
  root: string,
  opts: { paths?: string[]; onProgress?: (progress: IndexProgress) => void } = {},
): Promise<SyncResult> {
  const args = opts.paths ? { root, paths: opts.paths } : { root };
  const onProgress = opts.onProgress;
  // The payloads are the engine's IndexProgress objects, sent as they came (./sync-root-body.ts).
  const forward = onProgress && ((payload: unknown): void => onProgress(payload as IndexProgress));
  const outcome = await runJob(jobId, jobBodySpec(kind, root, 'sync-root-body', 'syncRootBody', args), forward) as SyncJobOutcome;
  if ('locked' in outcome) throw new LockUnavailableError(outcome.locked);
  return outcome.result;
}
