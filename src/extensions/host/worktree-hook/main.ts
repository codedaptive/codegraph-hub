/**
 * Entry point of the worktree PreToolUse hook: `node dist/extensions/host/worktree-hook/main.js`.
 *
 * Removes every `GIT_*` variable except GIT_EXEC_PATH from its own environment, so the root is found from the
 * payload's cwd alone and not from a repository, ceiling or config an inherited variable names. Then reads
 * the whole hook payload from stdin, prints the answer from `decideHookOutput` (one JSON line)
 * or nothing, and exits 0. The hook never exits 2, the one code that blocks a PreToolUse call: a hook that
 * only adjusts an argument must never stop a call. Every failure inside `main` (stdin that cannot be read,
 * an exception, git missing) ends as empty output and exit 0. A crash before `main` runs (a missing or
 * broken build) exits 1, which Claude Code reports as a non-blocking error, so the call still goes ahead.
 *
 * Imports only Node built-ins and ./worktree-hook, so each tool call pays for a bare Node start and one
 * `git rev-parse`, nothing more.
 */
import * as fs from 'fs';
import { clearGitEnvironment, decideHookOutput } from './worktree-hook';

function main(): void {
  let output: string | null = null;
  try {
    // The root must come from the payload's cwd alone. Claude Code's environment can carry GIT_DIR,
    // GIT_CEILING_DIRECTORIES, GIT_CONFIG_* and the like, which git obeys over the cwd. The process lives
    // for one call, so clearing its own environment here affects nothing else.
    clearGitEnvironment(process.env);
    // Fd 0 read to the end; a closed or unreadable stdin throws and is treated as empty.
    output = decideHookOutput(fs.readFileSync(0, 'utf8'));
  } catch {
    output = null;
  }
  if (output !== null) {
    try {
      fs.writeSync(1, `${output}\n`);
    } catch {
      // A closed stdout has nobody to tell; the exit code stays 0.
    }
  }
  process.exitCode = 0;
}

main();
