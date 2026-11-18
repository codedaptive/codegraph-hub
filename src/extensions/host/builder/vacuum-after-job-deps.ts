/** What the VACUUM after a job (./vacuum-after-job.ts) needs from the builder, and its test seams. */
import type { DbPageStats } from './db-page-stats-type';
import type { JobQueue } from './queue';
import type { VacuumWriterSlot } from './vacuum-writer-slot-type';

export interface VacuumAfterJobDeps {
  queue: Pick<JobQueue, 'enqueue'>;
  /** One line for the builder's job log. */
  jobLog(line: string): void;
  /** Whether a rebuild keeps the builder's writers off the root (./fences.ts rebuildHeld). */
  rebuildHeld(root: string): boolean;
  /** Test seams; the defaults are the real reads, the real VACUUM, the real writer slot and the 256 MiB floor. */
  readStats?: (dbPath: string) => DbPageStats | null;
  freeDisk?: (dir: string) => number | null;
  runVacuum?: (dbPath: string) => Promise<void>;
  /** Takes the root's writer slot for the VACUUM (default ./take-vacuum-writer-slot.ts takeVacuumWriterSlot). */
  takeWriterSlot?: (root: string) => VacuumWriterSlot;
  minFreelistBytes?: number;
}
