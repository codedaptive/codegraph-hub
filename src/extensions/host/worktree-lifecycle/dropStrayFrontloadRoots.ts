/**
 * The prompt hook's side of the rule that codegraph serves only git worktrees and folders opted in with
 * `codegraph init <dir> --no-git` (SPEC §3; R-50): an indexed root in neither is dropped from the hook's
 * plan, so the hook serves nothing for it and stays silent, as it does whenever it has nothing to serve.
 */
import { requireGitWorktreeRoot } from './requireGitWorktreeRoot';

/**
 * A copy of `plan` without the roots `inRepository` rejects: a rejected `exploreRoot` becomes null (an absent
 * one stays as it is, unchecked) and rejected `nudgeProjects` are removed, order kept. Other fields are copied.
 */
export function dropStrayFrontloadRoots<P extends { exploreRoot: string | null | undefined; nudgeProjects: string[] }>(
  plan: P,
  inRepository: (root: string) => boolean = (root) => 'root' in requireGitWorktreeRoot(root),
): P {
  return {
    ...plan,
    exploreRoot: typeof plan.exploreRoot === 'string' && !inRepository(plan.exploreRoot) ? null : plan.exploreRoot,
    nudgeProjects: plan.nudgeProjects.filter(inRepository),
  };
}
