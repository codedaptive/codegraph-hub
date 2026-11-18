/**
 * Whether a VACUUM of one database runs now (ruling R-45). The freelist rule (./freelist-over-limit.ts) is
 * checked first; then the free disk must be strictly more than twice the database file, since a VACUUM writes a
 * whole copy of the database before the old pages are given back. Unknown free disk counts as too little.
 */
import type { DbPageStats } from './db-page-stats-type';
import { freelistOverLimit } from './freelist-over-limit';

export function vacuumVerdict(
  stats: DbPageStats,
  freeDiskBytes: number | null,
  minFreelistBytes?: number,
): 'vacuum' | 'freelist-small' | 'disk-short' {
  if (!freelistOverLimit(stats, minFreelistBytes)) return 'freelist-small';
  if (freeDiskBytes === null || freeDiskBytes <= 2 * stats.pageCount * stats.pageSize) return 'disk-short';
  return 'vacuum';
}
