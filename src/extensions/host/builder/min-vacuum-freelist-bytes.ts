/**
 * 256 MiB: the smallest freelist a VACUUM is queued for (R-45, Bob's "256MB"). A quarter of a small index is a
 * few megabytes, so without this floor a small index would be rewritten after every job.
 */
export const MIN_VACUUM_FREELIST_BYTES = 268_435_456;
