/**
 * Whether a running builder job is over one of its limits (./job-limits.ts), from its elapsed wall time and
 * its process's resident size. Pure, so the watchdog that samples a job can be tested apart from this rule.
 */
import type { JobLimits } from './job-limits';

/** Which limit a job went over, with the limit and what was measured, for the log line and the error. */
export type LimitBreach =
  | { limit: 'time'; maxMs: number; measuredMs: number }
  | { limit: 'rss'; maxRssMb: number; measuredRssMb: number };

const BYTES_PER_MB = 1_048_576;

/**
 * The breach, or null when the job is within both limits. Only strictly more than a limit is over. When both
 * are over, the time breach is reported: one job, one reason.
 */
export function checkJobLimits(elapsedMs: number, rssBytes: number, limits: JobLimits): LimitBreach | null {
  if (elapsedMs > limits.maxMs) return { limit: 'time', maxMs: limits.maxMs, measuredMs: elapsedMs };
  if (rssBytes > limits.maxRssMb * BYTES_PER_MB) {
    return { limit: 'rss', maxRssMb: limits.maxRssMb, measuredRssMb: Math.round(rssBytes / BYTES_PER_MB) };
  }
  return null;
}
