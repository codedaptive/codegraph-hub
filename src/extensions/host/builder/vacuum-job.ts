/**
 * The body of the `vacuum` job (./vacuum-after-job.ts queues it), run in the job's own child process. It takes
 * the root's writer slot with the builder's pid as owner (`ctx.writerPid`, ./take-vacuum-writer-slot.ts) before
 * it decides: another live process holding it (or a lock that cannot be read) is logged and skipped; otherwise the
 * job keeps the slot until the VACUUM settles. It then decides again on what is on disk: a freelist since reused
 * (or stats that cannot be read) is left as it is, and a disk with no more than twice the database free is logged
 * and skipped, since a VACUUM writes a whole copy. Each log line goes to the builder as a `{log: line}` progress
 * payload, which the builder writes to its job log.
 *
 * The job's child calls it with `args` and `ctx` alone, so it runs on the real seams; a test passes its own.
 */
import * as path from 'node:path';
import type { WriterLockInfo } from '../../../mcp/writer-lock';
import type { DbPageStats } from './db-page-stats-type';
import { freeDiskBytes } from './free-disk-bytes';
import type { JobContext } from './job-context-type';
import { readDbPageStats } from './read-db-page-stats';
import { runVacuumOffThread } from './run-vacuum-off-thread';
import { takeVacuumWriterSlot } from './take-vacuum-writer-slot';
import type { VacuumWriterSlot } from './vacuum-writer-slot-type';
import { vacuumVerdict } from './vacuum-verdict';

interface VacuumJobSeams {
  readStats?: (dbPath: string) => DbPageStats | null;
  freeDisk?: (dir: string) => number | null;
  runVacuum?: (dbPath: string) => Promise<void>;
  takeWriterSlot?: (root: string, ownerPid: number) => VacuumWriterSlot;
  now?: () => Date;
}

export async function vacuumJob(
  args: { root: string; dbPath: string; minFreelistBytes: number },
  ctx: Pick<JobContext, 'progress' | 'writerPid'>,
  seams: VacuumJobSeams = {},
): Promise<'writer-held' | 'vacuum' | 'freelist-small' | 'disk-short'> {
  const { root, dbPath } = args;
  const now = seams.now ?? (() => new Date());
  const slot = (seams.takeWriterSlot ?? takeVacuumWriterSlot)(root, ctx.writerPid);
  if (slot.kind === 'busy') {
    ctx.progress({ log: writerHeldLine(root, slot.holder, now()) });
    return 'writer-held';
  }
  try {
    const stats = (seams.readStats ?? readDbPageStats)(dbPath);
    if (stats === null) return 'freelist-small';
    const free = (seams.freeDisk ?? freeDiskBytes)(path.dirname(dbPath));
    const verdict = vacuumVerdict(stats, free, args.minFreelistBytes);
    if (verdict === 'vacuum') await (seams.runVacuum ?? runVacuumOffThread)(dbPath);
    if (verdict === 'disk-short') ctx.progress({ log: skipLine(root, free, stats.pageCount * stats.pageSize, now()) });
    return verdict;
  } finally {
    slot.release();
  }
}

function writerHeldLine(root: string, holder: WriterLockInfo | null, at: Date): string {
  return `${at.toISOString()} vacuum skipped ${root}: ${holder === null
    ? 'writer.pid is held and could not be read'
    : `writer.pid is held by live process ${holder.pid} (${holder.mode})`}`;
}

function skipLine(root: string, free: number | null, dbBytes: number, at: Date): string {
  const why = free === null
    ? `free disk is unknown, so not known to be more than twice the database's ${dbBytes} bytes`
    : `free disk ${free} bytes is not more than twice the database's ${dbBytes} bytes`;
  return `${at.toISOString()} vacuum skipped ${root}: ${why}`;
}
