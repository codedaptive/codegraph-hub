/**
 * The project root `codegraph suspects` reads (ruling S-85): the nearest CodeGraph index at or above the
 * start path, refused when that index is stray (its root in no git worktree and never opted in). With no
 * index at all the answer is the no-index error, and worktree eligibility is not checked.
 */
import { findNearestCodeGraphRoot } from '../../directory';
import { requireGitWorktreeRoot } from '../host/worktree-lifecycle/requireGitWorktreeRoot';

/** The index root found from `start` (not the worktree root above it), or the error line to show. */
export function resolveSuspectsRoot(start: string): { root: string } | { error: string } {
  const root = findNearestCodeGraphRoot(start);
  if (!root) {
    return { error: `No CodeGraph index at or above ${start}. Run \`codegraph init\` in the project first.` };
  }
  const required = requireGitWorktreeRoot(root);
  if ('refusal' in required) return { error: required.refusal };
  return { root };
}
