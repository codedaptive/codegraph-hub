/**
 * The builder queue's event listener (./service.ts): every job's start and end line goes to the job log, and a
 * job's end may queue a VACUUM of its root (./vacuum-after-job.ts, R-45).
 *
 * The queue is read at each event, never when the listener is made: the listener is handed to the queue's own
 * constructor, before the queue exists. The listener swallows a failed VACUUM check, which only means no VACUUM;
 * a throwing listener or job log is caught by the queue's event callback (JobQueue's emit in ./queue.ts).
 */
import { formatJobLine, type JobEvent, type JobQueue } from './queue';
import { vacuumAfterJob } from './vacuum-after-job';

export function jobEventListener(parts: {
  jobLog(line: string): void;
  queue(): Pick<JobQueue, 'enqueue'>;
  rebuildHeld(root: string): boolean;
  vacuum?: { minFreelistBytes?: number; freeDiskBytes?: (dir: string) => number | null };
}): (event: JobEvent) => void {
  return (event) => {
    parts.jobLog(formatJobLine(event));
    // Only a job that ended ok can queue a VACUUM, so no other event reads the queue.
    if (event.edge !== 'end' || !event.ok) return;
    try {
      vacuumAfterJob(event, {
        queue: parts.queue(),
        jobLog: (line) => parts.jobLog(line),
        rebuildHeld: (root) => parts.rebuildHeld(root),
        minFreelistBytes: parts.vacuum?.minFreelistBytes,
        freeDisk: parts.vacuum?.freeDiskBytes,
      });
    } catch {
      // No VACUUM: the next job's end asks again.
    }
  };
}
