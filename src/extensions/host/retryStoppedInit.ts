/**
 * An explicit `codegraph init` of an initialized root the index builder stopped at a limit (SPEC S-69): the one
 * place besides `codegraph index` that clears the mark and tries again, under the same limits. It reads the root's
 * mark once. With a mark it hands it to `onRetry` (init says why it rebuilds), rebuilds as `codegraph index` does
 * (./rebuildIndex.ts), except that a server's unproven release is refused with `codegraph init` as the command to
 * retry, and answers whether the rebuild succeeded. With none it answers null: no rebuild ran, and the caller answers
 * for the initialized root.
 */
import type { EndedJob } from './builder/ended-job';
import { stoppedRootMark } from './builder/stopped-root-mark';
import { rebuildIndex } from './rebuildIndex';

export async function retryStoppedInit(
  projectPath: string,
  options: { force?: boolean; verbose?: boolean; yes?: boolean },
  deps: Parameters<typeof rebuildIndex>[2] & { onRetry: (mark: EndedJob) => void },
): Promise<boolean | null> {
  const mark = stoppedRootMark(projectPath);
  if (mark === null) return null;
  deps.onRetry(mark);
  return rebuildIndex(projectPath, options, { ...deps, retryCommand: '`codegraph init`' });
}
