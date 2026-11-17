/**
 * Which root `codegraph project pin` registers and pins (./cli.ts runProjectPin), for a path already known
 * to be inside the git worktree `gitRoot`.
 */
import { isInitialized } from '../../../directory';
import { gitWorktreeRootAsync } from './git';
import { gitRootByStat } from '../server/index-root';
import type { WorktreeSeedOutcome } from './seed';

/** Seed outcomes after which the worktree root holds (or will hold) the index, so it is the root pinned. */
const WORKTREE_PINNED_AFTER: ReadonlySet<WorktreeSeedOutcome['kind']> = new Set(['seeded', 'indexed', 'queued']);

/**
 * The root to pin for `absolute`. `indexRoot` is the root a tool call resolves the path to; when it is in no
 * git worktree (the index of a non-git folder above the worktree) it is not this project's, and `gitRoot`
 * stands in for it. When that root has an index it is the answer, with no seed. Otherwise, unless
 * CODEGRAPH_NO_AUTO_SEED is 1, the path's worktree root is seeded with `seed`: on `seeded`, `indexed` or
 * `queued` the worktree root is the answer; on any other outcome, or with the kill switch on, the resolved
 * root is.
 */
export async function choosePinRoot(
  absolute: string,
  gitRoot: string,
  indexRoot: string,
  seed: (worktree: string) => Promise<WorktreeSeedOutcome>,
): Promise<string> {
  const resolved = gitRootByStat(indexRoot) ? indexRoot : gitRoot;
  if (isInitialized(resolved) || process.env.CODEGRAPH_NO_AUTO_SEED === '1') return resolved;
  const worktree = await gitWorktreeRootAsync(absolute);
  if (!worktree) return resolved;
  const outcome = await seed(worktree);
  return WORKTREE_PINNED_AFTER.has(outcome.kind) ? worktree : resolved;
}
