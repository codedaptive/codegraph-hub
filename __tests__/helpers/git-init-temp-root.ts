/**
 * For tests that run `codegraph init`, `index` or `sync` on a temporary folder.
 * Those commands index only a git worktree (S-70, R-46) and refuse a folder in
 * none, which a plain `fs.mkdtempSync` folder is. This makes `dir` a git
 * repository (`git init -q`) and returns its real path: the CLI acts on the
 * worktree root as the filesystem names it (on macOS the temp dir is reached
 * through `/var` -> `/private/var`), so tests compare paths against this value.
 * Setup only: nothing here relaxes the refusal.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';

export function gitInitTempRoot(dir: string): string {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return fs.realpathSync(dir);
}
