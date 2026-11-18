/**
 * The builder queue's writer rule (./queue.ts) as a pick: the first waiting job none of whose roots is busy. The
 * pick is first-eligible, not first-in-first-out per root: a later job of a root can start before an earlier
 * waiting job that names it among other roots, while one of those other roots is busy.
 */
export function firstStartable<T extends { rootKeys: readonly string[] }>(entries: readonly T[], busy: ReadonlySet<string>): number {
  return entries.findIndex((entry) => !entry.rootKeys.some((key) => busy.has(key)));
}
