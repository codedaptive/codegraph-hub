/**
 * The CLI read commands' gate: a command that answers from an index (status, query, explore, context,
 * node, files, callers, callees, impact, implementations, affected, cycles, ui, checkpoint) answers only for a
 * git worktree or a folder opted in with `codegraph init <dir> --no-git` (SPEC §3; R-50). Any other path gets
 * requireGitWorktreeRoot's refusal and exit status 1, even when a `.codegraph/` index sits there.
 */
import { requireGitWorktreeRoot } from './requireGitWorktreeRoot';

/**
 * Returns when `projectPath` belongs to a git worktree or an opted-in folder; otherwise prints the refusal
 * once with `printError` and exits 1. `deps` replaces the root check and the exit, for tests.
 */
export function refuseReadOutsideRepository(
  projectPath: string,
  printError: (message: string) => void,
  deps: {
    require?: (p: string) => { root: string } | { refusal: string };
    exit?: (code: number) => never;
  } = {},
): void {
  const required = (deps.require ?? requireGitWorktreeRoot)(projectPath);
  if ('root' in required) return;
  printError(required.refusal);
  if (deps.exit) return deps.exit(1);
  process.exit(1);
}
