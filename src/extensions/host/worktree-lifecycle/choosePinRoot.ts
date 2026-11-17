/**
 * The root `codegraph project pin` registers and pins (./cli.ts runProjectPin): the git worktree root of the
 * path, seeded first when it has no index.
 */
import { isInitialized } from '../../../directory';
import type { WorktreeSeedOutcome } from './seed';

/**
 * Resolves to `gitRoot`, always. When it has no index and CODEGRAPH_NO_AUTO_SEED is not 1, `seed` is called
 * on it once first (the caller reports the outcome); the answer is `gitRoot` whatever the outcome.
 */
export async function choosePinRoot(
  gitRoot: string,
  seed: (worktree: string) => Promise<WorktreeSeedOutcome>,
): Promise<string> {
  if (!isInitialized(gitRoot) && process.env.CODEGRAPH_NO_AUTO_SEED !== '1') await seed(gitRoot);
  return gitRoot;
}
