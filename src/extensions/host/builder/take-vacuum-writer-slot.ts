/**
 * Takes a root's writer slot (writer.pid) for the VACUUM job (./vacuum-job.ts), which runs in its own child
 * process. `ownerPid` is the builder's pid (the job context's `writerPid`).
 *
 * A record that names `ownerPid` is the builder's hold on the root (./holder.ts): the VACUUM shares it and writes
 * nothing, and its release leaves the record in place; the hold releases it when it closes, after the root's jobs
 * end. Sharing it is safe from the builder's other jobs, which never run at once on one root (./next-start.ts).
 * Otherwise the slot is taken in mode 'builder' under this process's pid (the job's child): taken by another live
 * process (or unreadable) answers busy, and a slot taken here is freed on release.
 */
import { readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import type { VacuumWriterSlot } from './vacuum-writer-slot-type';

export function takeVacuumWriterSlot(root: string, ownerPid: number): VacuumWriterSlot {
  if (readWriterLock(root)?.pid === ownerPid) return { kind: 'held', release: () => {} };
  const result = tryAcquireWriterLock(root, 'builder');
  if (result.kind === 'taken') return { kind: 'busy', holder: result.existing };
  return { kind: 'held', release: () => releaseWriterLock(root) };
}
