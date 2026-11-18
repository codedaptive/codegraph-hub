/**
 * The body of every sync job (a held root's `sync`, `catch-up` and `watch-sync`, ./holder.ts, and the CLI's
 * `sync`, ./cli-jobs.ts), run in the job's child process: open the root's database writable, sync it (only
 * `paths` when given: the watcher's fast path), send each progress of the engine as a payload, and close.
 * The body takes no lock beyond the engine's own `codegraph.lock`: for a held root the builder holds
 * `writer.pid`. Lock contention is answered as `locked`, not thrown (./sync-job-outcome-type.ts).
 */
import CodeGraph from '../../../index';
import { LockUnavailableError } from '../../../errors';
import type { JobContext } from './job-context-type';
import { jsonValue } from './json-value';
import type { SyncJobOutcome } from './sync-job-outcome-type';

export async function syncRootBody(args: { root: string; paths?: string[] }, ctx: JobContext): Promise<SyncJobOutcome> {
  const cg = await CodeGraph.open(args.root);
  try {
    return { result: jsonValue(await cg.sync({ paths: args.paths, onProgress: (progress) => ctx.progress(progress) })) };
  } catch (err) {
    if (err instanceof LockUnavailableError) return { locked: err.message };
    throw err;
  } finally {
    cg.close();
  }
}
