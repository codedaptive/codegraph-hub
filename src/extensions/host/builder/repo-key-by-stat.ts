/**
 * The git repository a root belongs to, as the builder queue's lane key (./queue.ts; R-53: one lane per git
 * repository, all worktrees sharing one git common dir). Read from the files alone, with no git subprocess: a
 * `<root>/.git` directory is the repository's own git dir; a `.git` file (`gitdir: <dir>`, a linked worktree)
 * names its git dir, whose `commondir` file names the shared one relative to it. The key is the canonical path of
 * that directory. A root with no readable `.git`, a `.git` naming a missing git dir, or a missing root is its own
 * key (its canonical root). Never throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { canonicalProjectRoot } from '../../../directory';

/** The canonical common git dir of `gitDir`: its `commondir` resolved against it, else `gitDir` itself. */
function commonGitDir(gitDir: string): string {
  try {
    return fs.realpathSync(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()));
  } catch {
    return fs.realpathSync(gitDir);
  }
}

export function repoKeyByStat(root: string): string {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return fs.realpathSync(dotGit);
    const gitDir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
    if (gitDir !== undefined) return commonGitDir(path.resolve(root, gitDir));
  } catch {
    // No .git, an unreadable one, or one naming a missing git dir: the root is its own repository.
  }
  return canonicalProjectRoot(root);
}
