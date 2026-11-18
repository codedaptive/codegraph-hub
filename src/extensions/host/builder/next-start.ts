/**
 * The builder queue's pick (./queue.ts; R-53): which waiting job starts next, and in which slot, if any.
 *
 * Each repository (the key a job was queued under, ./repo-key-by-stat.ts) has one next job. It is the repository's
 * first waiting short job none of whose roots a running job holds (./first-startable.ts: first-eligible, so a
 * later job of a root can go before an earlier one blocked by another of its roots). With no such short job, it is
 * the repository's oldest whole-repository job (./is-whole-repository-job.ts), and only when none of that job's
 * roots is held by a running job or named by a waiting short job of the same repository: a later whole-repository
 * job never goes around it. So the short jobs of a root wait ahead of its whole-repository job only while that job
 * is still waiting; one queued after it started waits for it to end.
 *
 * A repository whose own slot is free starts its next job there, the earliest queued first. Otherwise the earliest
 * queued next job of a busy repository may take a free bypass slot, when the load average read at that start is
 * below {@link BYPASS_LOAD_LIMIT}. A running job is never stopped, whatever the load.
 */
import { firstStartable } from './first-startable';
import { isWholeRepositoryJob } from './is-whole-repository-job';
import type { JobLane } from './job-lane-type';
import type { JobKind } from './queue';

/**
 * Two bypass slots shared by every repository (R-53, Bob's figure): a busy repository's next job need not wait for
 * its own slot, and the builder still runs at most two jobs beyond one per repository.
 */
const BYPASS_LANES = 2;

/**
 * The machine's 1-minute load average at or above which no job starts in a bypass slot (R-53, Bob's figure): the
 * extra parallel work stays off a busy machine, and each repository's own slot still runs.
 */
const BYPASS_LOAD_LIMIT = 95;

interface Pickable {
  kind: JobKind;
  repo: string;
  rootKeys: readonly string[];
}

/** The next job of `repo` with its index in `waiting`; undefined when it has none that may start. */
function repoPick<T extends Pickable>(waiting: readonly T[], repo: string, busy: ReadonlySet<string>): { entry: T; index: number } | undefined {
  const own = waiting.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.repo === repo);
  const short = own.filter(({ entry }) => !isWholeRepositoryJob(entry.kind));
  // firstStartable's -1 (none) indexes nothing.
  const first = short[firstStartable(short.map(({ entry }) => entry), busy)];
  if (first !== undefined) return first;
  const whole = own.find(({ entry }) => isWholeRepositoryJob(entry.kind));
  if (whole === undefined) return undefined;
  const blockers = new Set([...busy, ...short.flatMap(({ entry }) => entry.rootKeys)]);
  return firstStartable([whole.entry], blockers) === 0 ? whole : undefined;
}

export function nextStart<T extends Pickable>(
  waiting: readonly T[],
  running: readonly { job: T; lane: JobLane }[],
  loadAverage: () => number,
): { index: number; lane: JobLane } | null {
  const busy = new Set(running.flatMap(({ job }) => job.rootKeys));
  const picks = [...new Set(waiting.map((entry) => entry.repo))]
    .flatMap((repo) => repoPick(waiting, repo, busy) ?? [])
    .sort((a, b) => a.index - b.index);
  const ownBusy = new Set(running.filter(({ lane }) => lane === 'repo').map(({ job }) => job.repo));
  const own = picks.find(({ entry }) => !ownBusy.has(entry.repo));
  if (own !== undefined) return { index: own.index, lane: 'repo' };
  const earliest = picks[0];
  const bypassBusy = running.filter(({ lane }) => lane === 'bypass').length;
  if (earliest === undefined || bypassBusy >= BYPASS_LANES || loadAverage() >= BYPASS_LOAD_LIMIT) return null;
  return { index: earliest.index, lane: 'bypass' };
}
