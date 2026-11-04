/**
 * Batching helpers for `IN (...)` lists, shared by every store in the zone
 * (`blast/store.ts`, `orphans/store.ts`): an id list of any length is split
 * into statements that each stay under SQLite's bound-parameter limit.
 */

/**
 * Ids per `IN (...)` list. SQLite's default bound-parameter limit is 32766 on
 * modern builds but 999 on old ones; 500 stays under both with room for the
 * `kind IN (...)` parameters that share the statement.
 */
export const MAX_IDS_PER_QUERY = 500;

/** `?, ?, ...` with `n` placeholders, for an `IN (...)` list. */
export function placeholders(n: number): string {
  return new Array<string>(n).fill('?').join(', ');
}

/** `xs` split into consecutive slices of at most `size`. */
export function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
