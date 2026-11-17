/**
 * The answer a tool call gets when it has no index to read because the index builder stopped the root's job
 * over a limit (./job-limits.ts). A success-shaped note, like the seed module's buildingNote: it names the
 * one variable for the limit that was hit and the explicit `codegraph index` that clears the mark, since the
 * builder never retries an ended job on its own, not even after it restarts. A stopped `vacuum` job is no such
 * reason (it leaves the index whole), so it never reaches this note (./ended-outcome.ts).
 */
import type { JobKind } from './queue';

export function endedJobNote(
  projectPath: string,
  ended: { root: string; kind: JobKind; limit: 'time' | 'rss' },
): string {
  const [limit, variable] = ended.limit === 'time'
    ? ['time limit', 'CODEGRAPH_BUILDER_JOB_MAX_MS']
    : ['memory limit', 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB'];
  return (
    `CodeGraph has no index for ${projectPath}: the index builder stopped the ${ended.kind} job of ` +
    `${ended.root} at its ${limit}, and it is not retried by itself. ` +
    `If the limit is too low, raise ${variable} in the environment the codegraph server starts from, ` +
    `then run \`codegraph index ${ended.root}\`. ` +
    'Use your built-in tools (Read/Grep/Glob) for this codebase meanwhile.'
  );
}
