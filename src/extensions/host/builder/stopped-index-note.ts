/**
 * The line every answer served from a root's index carries while the index builder's last job of that root
 * ended over a limit (./job-limits.ts) and an index is on disk: the index is served as it is, but it may be
 * partial or behind. Like ./ended-job-note.ts, it names the one variable for the limit that was hit and the
 * explicit `codegraph index` to run (an explicit `codegraph init` clears the mark too), since the builder never
 * retries an ended job on its own.
 * The line has no warning sign of its own: a tool answer puts `⚠️` before it, the CLI its warn glyph.
 */
import type { JobKind } from './queue';

export function stoppedIndexNote(mark: { root: string; kind: JobKind; limit: 'time' | 'rss' }): string {
  const [limit, variable] = mark.limit === 'time'
    ? ['time limit', 'CODEGRAPH_BUILDER_JOB_MAX_MS']
    : ['memory limit', 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB'];
  return (
    `The index builder stopped the last ${mark.kind} job of ${mark.root} at its ${limit}, ` +
    'so this index may be partial or behind. ' +
    `If the limit is too low, raise ${variable} in the environment the codegraph server starts from, ` +
    `then run \`codegraph index ${mark.root}\`.`
  );
}
