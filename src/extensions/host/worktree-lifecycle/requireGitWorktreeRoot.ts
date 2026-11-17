/**
 * The one rule every index write and every builder-backed read applies first: codegraph indexes only git
 * worktrees and the folders outside git a person opted in with `codegraph init <dir> --no-git` (SPEC §3,
 * "Only a git worktree root is indexed, unless a folder is opted in"; R-50). A path below such a root belongs
 * to that root; any other path is refused, whatever index may sit around it.
 */
import { gitRootByStat } from '../server/index-root';

/**
 * The root `projectPath` belongs to ({@link gitRootByStat}: stats only, the real location, the nearest `.git`
 * directory or file at or above it, else the nearest opted-in folder), or, for a path in neither, the refusal
 * to show the caller. The CLI prints the refusal as its error; the MCP handler and the builder answer with it.
 */
export function requireGitWorktreeRoot(projectPath: string): { root: string } | { refusal: string } {
  const root = gitRootByStat(projectPath);
  if (root !== null) return { root };
  return {
    refusal:
      `${projectPath} is not in a git repository, and codegraph indexes only git worktrees and the folders ` +
      'opted in to indexing, so it has no index to query or build there. Use a path inside a git repository, ' +
      'opt a folder outside git in once with `codegraph init <dir> --no-git`, or use your built-in tools ' +
      '(Read/Grep/Glob) for this code.',
  };
}
