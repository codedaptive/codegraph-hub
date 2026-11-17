/**
 * Whether a database's freelist is large enough to be worth a VACUUM (ruling R-45): strictly more than a quarter
 * of the file, and at least {@link MIN_VACUUM_FREELIST_BYTES} (./min-vacuum-freelist-bytes.ts).
 */
import type { DbPageStats } from './db-page-stats-type';
import { MIN_VACUUM_FREELIST_BYTES } from './min-vacuum-freelist-bytes';

export function freelistOverLimit(stats: DbPageStats, minFreelistBytes: number = MIN_VACUUM_FREELIST_BYTES): boolean {
  const freelistBytes = stats.freelistCount * stats.pageSize;
  return freelistBytes * 4 > stats.pageCount * stats.pageSize && freelistBytes >= minFreelistBytes;
}
