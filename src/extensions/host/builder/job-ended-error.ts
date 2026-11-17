/**
 * The error a builder job's caller gets when the job was ended over a limit (./job-limits.ts), or was asked
 * for again after such an end. The builder does not retry an ended job on its own, and its mark survives a
 * builder restart; only an explicit `codegraph index` or `codegraph init` of the root clears it, so the
 * message says that.
 */
import type { JobKind } from './queue';

export class JobEndedError extends Error {
  readonly root: string;
  readonly kind: JobKind;
  readonly limit: 'time' | 'rss';

  constructor(root: string, kind: JobKind, limit: 'time' | 'rss') {
    const which = limit === 'time' ? 'time limit (CODEGRAPH_BUILDER_JOB_MAX_MS)' : 'memory limit (CODEGRAPH_BUILDER_JOB_MAX_RSS_MB)';
    super(
      `The index builder ended the ${kind} job of ${root}: it went over its ${which}. ` +
      'It is not retried automatically, and a builder restart does not clear it; raise ' +
      'CODEGRAPH_BUILDER_JOB_MAX_MS or CODEGRAPH_BUILDER_JOB_MAX_RSS_MB if the limit is too low, then run ' +
      '`codegraph index` or `codegraph init` of the root to try again.',
    );
    this.name = 'JobEndedError';
    this.root = root;
    this.kind = kind;
    this.limit = limit;
  }
}
