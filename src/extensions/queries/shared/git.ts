/**
 * Shared git runner: `blast/diff.ts` reads diffs with
 * it, and `orphans/` reads the merge base and pre-image files with it.
 *
 * Git is run through `spawnSync` with an argument array, never a shell string,
 * so a ref or path from the caller is never interpreted by a shell. Callers
 * still refuse a ref beginning with `-` before it gets here (git would parse it
 * as an option).
 */
import { spawnSync } from 'node:child_process';

/** Run git in `root`, or return null when git fails (not a repo, unknown ref, missing path). */
export function git(root: string, args: string[]): string | null {
  const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // 64 MiB: room for `git diff --unified=0` on a large diff or
    // `git show` of a large file (spawnSync's default is 1 MiB, and an overflow
    // returns null here).
    maxBuffer: 64 * 1024 * 1024,
    // No console window flashes up for each git call on Windows (the rule for
    // child_process spawns under src/; a no-op elsewhere).
    windowsHide: true,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout;
}
