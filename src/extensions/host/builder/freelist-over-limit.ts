/**
 * Whether a database's freelist is large enough to be worth a VACUUM (ruling R-45): strictly more than a quarter
 * of the file, and at least {@link MIN_VACUUM_FREELIST_BYTES}. The byte floor keeps a small index, whose quarter
 * is a few megabytes, from being rewritten after every job.
 */
import type { DbPageStats } from './db-page-stats-type';

/** 256 MiB: the smallest freelist a VACUUM is queued for (R-45, "256MB"). */
export const MIN_VACUUM_FREELIST_BYTES = 268_435_456;

export function freelistOverLimit(stats: DbPageStats, minFreelistBytes: number = MIN_VACUUM_FREELIST_BYTES): boolean {
  const freelistBytes = stats.freelistCount * stats.pageSize;
  return freelistBytes * 4 > stats.pageCount * stats.pageSize && freelistBytes >= minFreelistBytes;
}
