/**
 * The builder's VACUUM rule (ruling R-45), run after each job that ends ok (./job-event-listener.ts): one that
 * left its root's freelist over the limit (./freelist-over-limit.ts) queues a `vacuum` job of that root. The VACUUM is a job of
 * its own, in the cold lane (./job-lane.ts): `sync` jobs of other roots run beside it, its own root's syncs queued
 * before it starts go first, and a job naming its root queued while it runs (its sync, or a `seed` copying from
 * it, S-78) waits for it (one writer per root); one queued
 * VACUUM per root is shared by every job that asks for it (its coalesce key).
 *
 * When the job runs, a rebuild that holds the root (a release or index fence, or another process's `rebuild.pid`)
 * leaves it alone. Otherwise it takes the root's writer slot (writer.pid, ./take-vacuum-writer-slot.ts) before it
 * decides: another live process holding it (or a lock that cannot be read) is logged and skipped; when this process
 * holds it (the slot was free, or the holder's own), the job runs and keeps the slot until the VACUUM settles. It
 * then decides again on what is on disk: a freelist since reused is left as it is, and a disk with no more than
 * twice the database free is logged and skipped, since a VACUUM writes a whole copy.
 * Ownership by this same process is still exposed to the holder's teardown (./holder.ts HolderSet.teardown frees
 * writer.pid without waiting for the root's jobs); that fix belongs in holder.ts.
 *
 * Never throws: it runs inside the queue's event callback, and a failed check only means no VACUUM.
 */
import * as path from 'node:path';
import { canonicalProjectRoot, getCodeGraphDir } from '../../../directory';
import type { DbPageStats } from './db-page-stats-type';
import { freeDiskBytes } from './free-disk-bytes';
import { freelistOverLimit } from './freelist-over-limit';
import { MIN_VACUUM_FREELIST_BYTES } from './min-vacuum-freelist-bytes';
import type { JobEvent } from './queue';
import { readDbPageStats } from './read-db-page-stats';
import { runVacuumOffThread } from './run-vacuum-off-thread';
import { takeVacuumWriterSlot } from './take-vacuum-writer-slot';
import type { VacuumAfterJobDeps } from './vacuum-after-job-deps';
import { vacuumVerdict } from './vacuum-verdict';
import type { WriterLockInfo } from '../../../mcp/writer-lock';

type VacuumOutcome = 'fenced' | 'writer-held' | 'vacuum' | 'freelist-small' | 'disk-short';

export function vacuumAfterJob(event: JobEvent, deps: VacuumAfterJobDeps): void {
  if (event.edge !== 'end' || !event.ok || event.kind === 'vacuum') return;
  const { root } = event;
  const readStats = deps.readStats ?? readDbPageStats;
  const minFreelistBytes = deps.minFreelistBytes ?? MIN_VACUUM_FREELIST_BYTES;
  try {
    const dbPath = path.join(getCodeGraphDir(root), 'codegraph.db');
    const stats = readStats(dbPath);
    if (stats === null || !freelistOverLimit(stats, minFreelistBytes)) return;
    const body = (): Promise<VacuumOutcome> => vacuumBody(root, dbPath, deps, readStats, minFreelistBytes);
    // A rejection is the queue's to log (a failed end); a closed queue or an ended vacuum means no VACUUM.
    deps.queue.enqueue('vacuum', root, body, { coalesceKey: `vacuum:${canonicalProjectRoot(root)}` }).catch(() => {});
  } catch {
    // No VACUUM: the next job's end asks again.
  }
}

async function vacuumBody(
  root: string,
  dbPath: string,
  deps: VacuumAfterJobDeps,
  readStats: (dbPath: string) => DbPageStats | null,
  minFreelistBytes: number,
): Promise<VacuumOutcome> {
  if (deps.rebuildHeld(root)) return 'fenced';
  const slot = (deps.takeWriterSlot ?? takeVacuumWriterSlot)(root);
  if (slot.kind === 'busy') {
    deps.jobLog(writerHeldLine(root, slot.holder));
    return 'writer-held';
  }
  try {
    const stats = readStats(dbPath);
    if (stats === null) return 'freelist-small';
    const free = (deps.freeDisk ?? freeDiskBytes)(path.dirname(dbPath));
    const verdict = vacuumVerdict(stats, free, minFreelistBytes);
    if (verdict === 'vacuum') await (deps.runVacuum ?? runVacuumOffThread)(dbPath);
    if (verdict === 'disk-short') deps.jobLog(skipLine(root, free, stats.pageCount * stats.pageSize));
    return verdict;
  } finally {
    slot.release();
  }
}

function writerHeldLine(root: string, holder: WriterLockInfo | null): string {
  const why = holder === null
    ? 'writer.pid is held and could not be read'
    : `writer.pid is held by live process ${holder.pid} (${holder.mode})`;
  return `${new Date().toISOString()} vacuum skipped ${root}: ${why}`;
}

function skipLine(root: string, free: number | null, dbBytes: number): string {
  const why = free === null
    ? `free disk is unknown, so not known to be more than twice the database's ${dbBytes} bytes`
    : `free disk ${free} bytes is not more than twice the database's ${dbBytes} bytes`;
  return `${new Date().toISOString()} vacuum skipped ${root}: ${why}`;
}
