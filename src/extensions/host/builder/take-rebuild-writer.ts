/**
 * The locks of a `codegraph index` rebuild job (./cli-jobs.ts), taken in the builder before its child runs. The
 * builder's own hold of the root (its watcher and `writer.pid`) goes first: the server released its handle before
 * it asked for this job, but a hold of the builder's may still be there: an `open` job that ran after the fence
 * refuses to open (./holder.ts openWritable), leaving the hold entry. This job is the root's running job, so the
 * release must not wait for the root to go idle. Then `writer.pid` is taken with mode `rebuild` under the
 * builder's pid, for the lease to release at `unfence`: a lock under the child's pid would be left behind when
 * the child exits.
 */
import { tryAcquireWriterLock, writerLockHeldMessage } from '../../../mcp/writer-lock';
import type { RebuildLease } from './fences';
import type { HolderSet } from './holder';

export async function takeRebuildWriter(lease: RebuildLease, holders: Pick<HolderSet, 'release'>): Promise<void> {
  lease.assertLive();
  await holders.release(lease.root, { fromJobOfRoot: true });
  const writer = tryAcquireWriterLock(lease.root, 'rebuild');
  if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
  lease.noteWriter();
}
