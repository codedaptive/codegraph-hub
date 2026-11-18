/**
 * The line a job body reported as a `{log: line}` progress payload (./job-context-type.ts), for the builder to
 * write where the job's lines go; null for any other payload.
 */
export function progressLogLine(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'log' in payload && typeof payload.log === 'string') return payload.log;
  return null;
}
