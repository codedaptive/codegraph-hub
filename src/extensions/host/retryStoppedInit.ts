/**
 * An explicit `codegraph init` of an initialized root the index builder stopped at a limit (SPEC S-69): the one
 * place besides `codegraph index` that clears the mark and tries again, under the same limits. Null when the root
 * has no mark, so init answers that the root is initialized; otherwise whether the rebuild (./rebuildIndex.ts) succeeded.
 */
import type { IndexWriter } from './builder/cli-route';
import { stoppedRootMark } from './builder/stopped-root-mark';
import { rebuildIndex } from './rebuildIndex';

export async function retryStoppedInit(
  projectPath: string,
  options: { force?: boolean; verbose?: boolean; yes?: boolean },
  runIndexOn: (writer: IndexWriter, dbPath: string, projectPath: string, options: { quiet?: boolean; verbose?: boolean; yes?: boolean }) => Promise<boolean>,
): Promise<boolean | null> {
  if (stoppedRootMark(projectPath) === null) return null;
  return rebuildIndex(projectPath, options, runIndexOn);
}
