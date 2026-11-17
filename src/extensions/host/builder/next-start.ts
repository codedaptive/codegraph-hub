/**
 * The builder queue's writer rule (./queue.ts) as one pick: which waiting job starts next, if any. The sync lane
 * goes first, with its first job whose roots no running job holds (./first-startable.ts). Then the cold lane's
 * head, first in first out: it starts only when none of its roots is held by a running job or named by a waiting
 * sync job, so a root's queued syncs go before its cold write. A lane that runs a job starts nothing.
 */
import { firstStartable } from './first-startable';
import type { JobLane } from './job-lane-type';

export function nextStart<T extends { rootKeys: readonly string[] }>(state: {
  syncJobs: readonly T[];
  coldJobs: readonly T[];
  running: ReadonlyMap<JobLane, T>;
}): { lane: JobLane; index: number } | null {
  const busy = new Set([...state.running.values()].flatMap((entry) => entry.rootKeys));
  const index = state.running.has('sync') ? -1 : firstStartable(state.syncJobs, busy);
  if (index >= 0) return { lane: 'sync', index };
  const head = state.coldJobs[0];
  if (head === undefined || state.running.has('cold')) return null;
  const blockers = new Set([...busy, ...state.syncJobs.flatMap((entry) => entry.rootKeys)]);
  return firstStartable([head], blockers) === 0 ? { lane: 'cold', index: 0 } : null;
}
