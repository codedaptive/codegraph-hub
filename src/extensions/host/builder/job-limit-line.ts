/**
 * The `<state dir>/builder.log` line for a job ended over one of its limits, beside the start and end lines of
 * ./queue.ts. It names the variable that sets the limit, so whoever reads the log knows what to raise.
 */
import type { LimitBreach } from './job-limit-breach';
import type { JobKind } from './queue';

/**
 * `<ISO8601> job limit <kind> <root> time <measured> ms > <max> ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried`,
 * or the same with `rss <measured> MB > <max> MB (CODEGRAPH_BUILDER_JOB_MAX_RSS_MB)`.
 */
export function formatLimitLine(job: { kind: JobKind; root: string }, breach: LimitBreach, now: Date = new Date()): string {
  const over = breach.limit === 'time'
    ? `time ${breach.measuredMs} ms > ${breach.maxMs} ms (CODEGRAPH_BUILDER_JOB_MAX_MS)`
    : `rss ${breach.measuredRssMb} MB > ${breach.maxRssMb} MB (CODEGRAPH_BUILDER_JOB_MAX_RSS_MB)`;
  return `${now.toISOString()} job limit ${job.kind} ${job.root} ${over}; ended, not retried`;
}
