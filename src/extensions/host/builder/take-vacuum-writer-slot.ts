/**
 * Takes a root's writer slot (writer.pid) for the VACUUM job (./vacuum-after-job.ts), in mode 'builder'.
 *
 * A slot this process already held before the call is the holder's (./holder.ts): it owns that record, so the
 * release leaves it in place. A slot the VACUUM took itself is freed on release. Sharing the holder's slot is safe
 * from this builder's own jobs, which never run at once on one root (./next-start.ts); HolderSet.teardown can
 * still free it while the VACUUM runs (see ./vacuum-after-job.ts).
 *
 * Ownership is judged by `process.pid`, so this assumes the job runs in the builder process itself.
 */
import { readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import type { VacuumWriterSlot } from './vacuum-writer-slot-type';

export function takeVacuumWriterSlot(root: string): VacuumWriterSlot {
  const ownedBefore = readWriterLock(root)?.pid === process.pid;
  const result = tryAcquireWriterLock(root, 'builder');
  if (result.kind === 'taken') return { kind: 'busy', holder: result.existing };
  return { kind: 'held', release: ownedBefore ? () => {} : () => releaseWriterLock(root) };
}
