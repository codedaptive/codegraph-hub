/** What the VACUUM job (./vacuum-job.ts) gets when it asks for its root's writer slot (writer.pid). */
import type { WriterLockInfo } from '../../../mcp/writer-lock';

/**
 * `held`: the VACUUM may write: the builder's hold has the slot, or the job took it (./take-vacuum-writer-slot.ts);
 * `release` is called once when the job ends.
 * `busy`: another live process holds it (`holder` is its record), or the lock could not be read (`holder` null).
 */
export type VacuumWriterSlot = { kind: 'held'; release(): void } | { kind: 'busy'; holder: WriterLockInfo | null };
