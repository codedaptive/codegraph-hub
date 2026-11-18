/**
 * The refusal queries' CLI reads (`grep`, `blast`, `orphans`) give first, so they refuse as host's built-in
 * reads do (S-82, S-84): only git worktrees and folders opted in with `codegraph init <dir> --no-git` are
 * answered, whatever index sits in any other folder.
 */
import { isInitialized } from '../../../directory';
import { requireGitWorktreeRoot } from '../../host/worktree-lifecycle/requireGitWorktreeRoot';

/**
 * The `✗` line to print as the command's error for `root`, or null to go on. A root with no index gets null,
 * so each command's own no-index answer comes first, as host checks `isInitialized` before it refuses.
 */
export function readRefusal(root: string): string | null {
  if (!isInitialized(root)) return null;
  const owner = requireGitWorktreeRoot(root);
  return 'root' in owner ? null : `✗ ${owner.refusal}\n`;
}
