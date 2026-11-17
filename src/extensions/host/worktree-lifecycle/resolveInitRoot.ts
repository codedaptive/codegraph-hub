/**
 * The root `codegraph init` initializes, and the opt-in of a folder outside git (R-50, SPEC §3 "Only a git
 * worktree root is indexed, unless a folder is opted in"). `--no-git` is the only way a folder outside git is
 * opted in; `--force` overrides only the unsafe-root refusal and never opts a folder in.
 */
import * as fs from 'fs';
import { canonicalProjectRoot, unsafeIndexRootReason } from '../../../directory';
import { registerProject } from './project-registry';
import { requireGitWorktreeRoot } from './requireGitWorktreeRoot';

/**
 * A path in a git worktree or an already opted-in folder initializes that root (`optedIn: false`, nothing
 * written, `noGit` ignored). Any other path is refused unless `noGit`: then it must be an existing directory,
 * and one that looks like the home directory, a parent of it or a filesystem root is refused without `force`;
 * otherwise its canonical root is registered opted in (`optedIn: true`). A refusal writes nothing.
 */
export function resolveInitRoot(
  projectPath: string,
  opts: { noGit: boolean; force: boolean },
): { root: string; optedIn: boolean } | { refusal: string } {
  const required = requireGitWorktreeRoot(projectPath);
  if ('root' in required) return { root: required.root, optedIn: false };
  if (!opts.noGit) return required;
  if (!isDirectory(projectPath)) return { refusal: `${projectPath} is not a directory, so it cannot be opted in to indexing.` };
  const canonical = canonicalProjectRoot(projectPath);
  const unsafe = unsafeIndexRootReason(canonical);
  if (unsafe && !opts.force) {
    return {
      refusal:
        `Refusing to initialize in ${canonical} — it looks like ${unsafe}. Run this inside a specific project ` +
        'directory, or pass --force if you really mean to index everything under it.',
    };
  }
  registerProject(canonical, { noGit: true });
  return { root: canonical, optedIn: true };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
