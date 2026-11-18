/** Run one step of a job-limit ending (./job-limit-guard.ts); a failure never stops the steps after it. */
export function attempt(step: () => void): void {
  try {
    step();
  } catch {
    // Best-effort: the ending goes on whatever this step left.
  }
}
