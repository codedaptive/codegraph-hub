/**
 * The builder's side of a sync job: run ./sync-root-body.ts for job `jobId` of `kind` on `root` through
 * `runJob`, with `paths` when the sync is scoped to them, and answer its SyncResult. A `locked` answer is thrown
 * as the LockUnavailableError the body caught (./sync-job-outcome-type.ts). `onProgress` gets the engine's
 * progress in order.
 */
import type { IndexProgress, SyncResult } from '../../../extraction';
import { LockUnavailableError } from '../../../errors';
import { isIndexProgress } from './is-index-progress';
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
  const outcome = await runJob<SyncJobOutcome>(
    jobId,
    jobBodySpec(kind, root, 'sync-root-body', 'syncRootBody', opts.paths ? { root, paths: opts.paths } : { root }),
    // The body sends only the engine's IndexProgress objects, as they came (./sync-root-body.ts).
    (payload) => { if (isIndexProgress(payload)) opts.onProgress?.(payload); },
  );
  if ('locked' in outcome) throw new LockUnavailableError(outcome.locked);
  return outcome.result;
}
