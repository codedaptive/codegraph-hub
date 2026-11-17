/**
 * The one rule every index write and every builder-backed read applies first: codegraph indexes only git
 * worktrees (SPEC §3, "Only a git worktree root is indexed"). A path below a worktree root belongs to that
 * root; a path with no `.git` entry at or above it is refused, whatever index may sit around it.
 */
import { gitRootByStat } from '../server/index-root';

/**
 * The git worktree root `projectPath` belongs to ({@link gitRootByStat}: stats only, the real location, the
 * nearest `.git` directory or file at or above it), or, for a path in no git worktree, the refusal to show the
 * caller. The CLI prints the refusal as its error; the MCP handler and the builder answer with it.
 */
export function requireGitWorktreeRoot(projectPath: string): { root: string } | { refusal: string } {
  const root = gitRootByStat(projectPath);
  if (root !== null) return { root };
  return {
    refusal:
      `${projectPath} is not in a git repository, and codegraph indexes only git worktrees, so it has no index ` +
      'to query or build there. Use a path inside a git repository, or your built-in tools (Read/Grep/Glob) ' +
      'for code outside one.',
  };
}
