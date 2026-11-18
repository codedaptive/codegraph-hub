import { JobQueue, type JobEvent } from '../../../../src/extensions/host/builder/queue';

/** A queue that records its events as `start kind root` / `end kind root`. */
export function recordingQueue(repoOf: (root: string) => string = (root) => root, loadAverage: () => number = () => 95): { queue: JobQueue; events: string[]; raw: JobEvent[] } {
  const events: string[] = [];
  const raw: JobEvent[] = [];
  const queue = new JobQueue({
    repoOf, loadAverage,
    onEvent: (e) => {
      raw.push(e);
      events.push(`${e.edge} ${e.kind} ${e.root}`);
    },
  });
  return { queue, events, raw };
}
