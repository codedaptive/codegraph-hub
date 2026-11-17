/**
 * The builder's VACUUM rule (ruling R-45), run after every job's event: a job that ended ok and left its root's
 * freelist over the limit (./freelist-over-limit.ts) queues a `vacuum` job of that root. The VACUUM is a job of
 * its own, in the cold class, so it waits behind every queued sync and never holds up an agent's edit; one queued
 * VACUUM per root is shared by every job that asks for it (its coalesce key).
 *
 * When the job runs it decides again on what is on disk then: a rebuild that holds the root (a release or index
 * fence, or another process's `rebuild.pid`) leaves it alone, a freelist since reused is left as it is, and a
 * disk with no more than twice the database free is logged and skipped, since a VACUUM writes a whole copy.
 *
 * Never throws: it runs inside the queue's event callback, and a failed check only means no VACUUM.
 */
import * as path from 'node:path';
import { canonicalProjectRoot, getCodeGraphDir } from '../../../directory';
import type { DbPageStats } from './db-page-stats-type';
import { freeDiskBytes } from './free-disk-bytes';
import { MIN_VACUUM_FREELIST_BYTES, freelistOverLimit } from './freelist-over-limit';
import type { JobEvent, JobQueue } from './queue';
import { readDbPageStats } from './read-db-page-stats';
import { runVacuumOffThread } from './run-vacuum-off-thread';
import { vacuumVerdict } from './vacuum-verdict';

export interface VacuumAfterJobDeps {
  queue: Pick<JobQueue, 'enqueue'>;
  /** One line for the builder's job log. */
  jobLog(line: string): void;
  /** Whether a rebuild keeps the builder's writers off the root (./fences.ts rebuildHeld). */
  rebuildHeld(root: string): boolean;
  /** Test seams; the defaults are the real reads, the real VACUUM and the 256 MiB floor. */
  readStats?: (dbPath: string) => DbPageStats | null;
  freeDisk?: (dir: string) => number | null;
  runVacuum?: (dbPath: string) => Promise<void>;
  minFreelistBytes?: number;
}

type VacuumOutcome = 'fenced' | 'vacuum' | 'freelist-small' | 'disk-short';

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
  const stats = readStats(dbPath);
  if (stats === null) return 'freelist-small';
  const free = (deps.freeDisk ?? freeDiskBytes)(path.dirname(dbPath));
  const verdict = vacuumVerdict(stats, free, minFreelistBytes);
  if (verdict === 'vacuum') await (deps.runVacuum ?? runVacuumOffThread)(dbPath);
  if (verdict === 'disk-short') deps.jobLog(skipLine(root, free, stats.pageCount * stats.pageSize));
  return verdict;
}

function skipLine(root: string, free: number | null, dbBytes: number): string {
  const why = free === null
    ? `free disk is unknown, so not known to be more than twice the database's ${dbBytes} bytes`
    : `free disk ${free} bytes is not more than twice the database's ${dbBytes} bytes`;
  return `${new Date().toISOString()} vacuum skipped ${root}: ${why}`;
}
