/**
 * The builder queue's writer rule (./queue.ts) as a pick: the first waiting job none of whose roots is busy.
 * Earlier entries keep their place, so jobs of one root still start in the order they were queued.
 */
export function firstStartable<T extends { rootKeys: readonly string[] }>(entries: readonly T[], busy: ReadonlySet<string>): number {
  return entries.findIndex((entry) => !entry.rootKeys.some((key) => busy.has(key)));
}
