import { execFileSync } from 'child_process';

/** Runs git in `cwd`, with no console window on Windows, and returns its trimmed stdout; stderr is dropped. */
export function gitHidden(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
