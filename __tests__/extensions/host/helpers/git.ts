import { execFileSync } from 'child_process';

/** Runs git in `cwd` and returns its trimmed stdout; stderr is dropped. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
