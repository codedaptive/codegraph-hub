/**
 * Which job kinds write or rewrite a whole repository's index: `cold-build`, the CLI's `init` and `index`
 * (./cli-jobs.ts), and the VACUUM of a root's index (`vacuum`, ./vacuum-after-job.ts; R-45). They run for
 * minutes, so within a repository's lane the short kinds (a changed file or two, a copy, an open) go ahead of
 * them (./next-start.ts).
 */
import type { JobKind } from './queue';

export function isWholeRepositoryJob(kind: JobKind): boolean {
  return kind === 'cold-build' || kind === 'init' || kind === 'index' || kind === 'vacuum';
}
