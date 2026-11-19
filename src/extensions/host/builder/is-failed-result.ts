/**
 * Whether a job's resolved value is a failed result: an object whose `success` is `false`, as a failed index
 * resolves (an IndexResult, ./run-index-job.ts). The queue (./queue.ts) keeps a root's ended marks after an
 * `init` or `index` that resolves with one. Any other value (`undefined`, a successful result) is not a failure.
 */
export function isFailedResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'success' in value && value.success === false;
}
