/**
 * The builder's VACUUM rule (ruling R-45), run after each job that ends ok (./job-event-listener.ts): one that
 * left its root's freelist over the limit (./freelist-over-limit.ts) queues a `vacuum` job of that root. The
 * VACUUM is a job of its own, a whole-repository job in its repository's lane: `sync` jobs of other roots run
 * beside it, its own root's syncs queued before it starts go first, and a job naming its root queued while it
 * runs (its sync, or a `seed` copying from it, S-78) waits for it (one writer per root); one queued VACUUM per
 * root is shared by every job that asks for it (its coalesce key).
 *
 * When the job runs, a rebuild that holds the root (a release or index fence, or another process's `rebuild.pid`)
 * leaves it alone, and no child is started. Otherwise its body runs in its own child process through `runJob`
 * (./vacuum-job.ts: the writer slot, the checks on disk and the VACUUM itself), and each `{log: line}` the body
 * reports is written to the job log.
 *
 * Never throws: it runs inside the queue's event callback, and a failed check only means no VACUUM.
 */
import * as path from 'node:path';
import { canonicalProjectRoot, getCodeGraphDir } from '../../../directory';
import { freelistOverLimit } from './freelist-over-limit';
import { jobBodySpec } from './job-body-spec';
import { MIN_VACUUM_FREELIST_BYTES } from './min-vacuum-freelist-bytes';
import { progressLogLine } from './progress-log-line';
import type { JobEvent } from './queue';
import { readDbPageStats } from './read-db-page-stats';
import type { VacuumAfterJobDeps } from './vacuum-after-job-deps';

export function vacuumAfterJob(event: JobEvent, deps: VacuumAfterJobDeps): void {
  if (event.edge !== 'end' || !event.ok || event.kind === 'vacuum') return;
  const { root } = event;
  const minFreelistBytes = deps.minFreelistBytes ?? MIN_VACUUM_FREELIST_BYTES;
  try {
    const dbPath = path.join(getCodeGraphDir(root), 'codegraph.db');
    const stats = (deps.readStats ?? readDbPageStats)(dbPath);
    if (stats === null || !freelistOverLimit(stats, minFreelistBytes)) return;
    const spec = jobBodySpec('vacuum', root, 'vacuum-job', 'vacuumJob', { root, dbPath, minFreelistBytes });
    const body = async ({ id }: { id: number }): Promise<unknown> => {
      if (deps.rebuildHeld(root)) return 'fenced';
      return deps.runJob(id, spec, (payload) => {
        const line = progressLogLine(payload);
        if (line !== null) deps.jobLog(line);
      });
    };
    // A rejection is the queue's to log (a failed end); a closed queue or an ended vacuum means no VACUUM.
    deps.queue.enqueue('vacuum', root, body, { coalesceKey: `vacuum:${canonicalProjectRoot(root)}` }).catch(() => {});
  } catch {
    // No VACUUM: the next job's end asks again.
  }
}
