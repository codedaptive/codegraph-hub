/**
 * Git helpers for the worktree lifecycle: list a repository's worktrees, count
 * the commits between two HEADs, and find a directory's working-tree root and
 * git common dir. The git calls are async and bounded, so the MCP server's
 * main thread (or the index builder's) can await them. The seeder (./seed.ts) uses them to copy a fresh
 * worktree's index from its nearest indexed sibling, and the cold build
 * (./cold-build.ts) and `codegraph project pin` (./cli.ts) use them to record
 * a project's repository. `nearestExistingDirectory` and the git-free
 * pre-check `gitWorktreeRootMayBeBelow` (./seed-check.ts) are synchronous
 * stats.
 *
 * Every git helper is best-effort: when git is unavailable or the path isn't
 * a repository, it returns null and callers carry on. Every git call of the
 * worktree lifecycle, here and in ./teardown.ts, runs with {@link gitEnv}: the
 * variables that point git at some other repository, and the config a parent
 * process injected for its own git invocation, are removed, so git answers
 * about the directory (or the `--git-dir`) it is given, under the user's own
 * config files.
 *
 * A git common dir, and the worktree paths `listGitWorktrees` reports, are
 * spelled by {@link canonicalGitPath} wherever they are recorded or compared.
 * A project root (a registry key, a worktree's toplevel in the teardown check)
 * is spelled by `canonicalProjectRoot` (src/directory.ts), which also
 * lowercases on Windows.
 *
 * The synchronous detection helpers (`gitWorktreeRoot`, `gitCommonDir`, the
 * borrowed-index warning) live in src/sync/worktree.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Bound on every git call below. Same rationale as the 5 s bound on the sync
 * helpers in src/sync/worktree.ts: the MCP server's main thread awaits these,
 * and a hung git must not hold a tool call (or the liveness watchdog's
 * patience) indefinitely.
 */
const GIT_ASYNC_TIMEOUT_MS = 5000;

/**
 * Environment variables that make git use a repository, index, object store
 * or discovery rule other than the one its working directory leads to. A
 * server started from a git hook (which exports GIT_DIR), or from a shell that
 * set one, would otherwise answer every question about a worktree with facts
 * about that other repository: the wrong siblings to seed from, the wrong
 * common dir recorded, and the wrong worktree list for the teardown's judge.
 */
const GIT_REPOSITORY_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
]);

/**
 * Config injected for one invocation rather than read from a config file:
 * `git -c` travels to every git it starts (a hook, and so a server a hook
 * starts) as GIT_CONFIG_PARAMETERS; GIT_CONFIG_COUNT with each
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pair ({@link GIT_CONFIG_PAIR_ENV})
 * does the same from the environment; GIT_CONFIG names a file for `git config`.
 * Such a setting was meant for that one command, not for the lifecycle's
 * questions about a worktree. The user's own config files
 * (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM) are not
 * injections and stay.
 */
const GIT_CONFIG_INJECTION_ENV = new Set([
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG',
]);

/** One injected config pair: GIT_CONFIG_KEY_<n> or GIT_CONFIG_VALUE_<n>. */
const GIT_CONFIG_PAIR_ENV = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/**
 * This process's environment without {@link GIT_REPOSITORY_ENV} and
 * without the config injections ({@link GIT_CONFIG_INJECTION_ENV},
 * {@link GIT_CONFIG_PAIR_ENV}), plus `extra`: the environment of every git
 * call of the worktree lifecycle. Windows matches variable names without
 * regard to case, so there a `Git_Dir` or a `git_config_key_0` is removed too.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (GIT_REPOSITORY_ENV.has(name) || GIT_CONFIG_INJECTION_ENV.has(name) || GIT_CONFIG_PAIR_ENV.test(name)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The one spelling of a directory the worktree lifecycle records and compares
 * (a worktree root from git, a git common dir): the OS's realpath
 * (`realpathSync.native`), which on a case-insensitive volume (macOS APFS,
 * NTFS) also gives each component its casing on disk, so `/x/Repo/.git` and
 * `/x/repo/.git` read as the one directory they are. Node's own realpath,
 * which keeps the caller's casing, only where the native call fails; the
 * resolved path where neither can answer (the directory is gone).
 */
export function canonicalGitPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch { /* fall back to the JS realpath */ }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * stdout of `git <args>` run in `cwd`, trimmed; null on any failure (git
 * missing, not a repository, a non-zero exit, the timeout). Async on purpose:
 * one sync spawn per sibling worktree on the server's main thread could stall
 * the event loop long enough to trip the 60 s liveness watchdog.
 */
function gitAsync(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        {
          cwd,
          env: gitEnv(),
          encoding: 'utf8',
          windowsHide: true,
          timeout: GIT_ASYNC_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        },
        (err, stdout) => resolve(err ? null : String(stdout).trim()),
      );
    } catch {
      resolve(null);
    }
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest existing directory at or above `p` (git needs one to run in); null at none. */
export function nearestExistingDirectory(p: string): string | null {
  let dir = path.resolve(p);
  while (!isDirectory(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return dir;
}

/**
 * Git-free pre-check: could `startPath` be in a git working tree whose root
 * lies strictly below `indexRoot` (anywhere at all, when `indexRoot` is null)?
 * True when some directory from `startPath`'s nearest existing directory up
 * to, not including, `indexRoot` holds a `.git` entry (a directory for a main
 * checkout, a file for a linked worktree or a submodule). False means no
 * working-tree root can sit there, so the caller needs no git call to know
 * the index it resolved is the tree's own (or there is no tree). A few stats,
 * for the hot path of every tool call. Repositories found only through
 * `GIT_DIR` / `GIT_WORK_TREE` are not seen, which costs a missed seed, never
 * a wrong answer.
 */
export function gitWorktreeRootMayBeBelow(startPath: string, indexRoot: string | null): boolean {
  let dir = nearestExistingDirectory(startPath);
  if (!dir) return false;
  const stop = indexRoot ? path.resolve(indexRoot) : null;
  while (dir !== stop) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

/** The toplevel of `dir`'s working tree (`git rev-parse --show-toplevel`), by {@link canonicalGitPath}, or null. */
export async function gitWorktreeRootAsync(dir: string): Promise<string | null> {
  const cwd = nearestExistingDirectory(dir);
  if (!cwd) return null;
  const out = await gitAsync(cwd, ['rev-parse', '--show-toplevel']);
  return out ? canonicalGitPath(out) : null;
}

/**
 * The git common dir of `dir`'s repository, by {@link canonicalGitPath} (`git rev-parse
 * --git-common-dir`, the `.git` every worktree of one repository shares), or null.
 */
export async function gitCommonDirAsync(dir: string): Promise<string | null> {
  const cwd = nearestExistingDirectory(dir);
  if (!cwd) return null;
  const out = await gitAsync(cwd, ['rev-parse', '--git-common-dir']);
  if (!out) return null;
  return canonicalGitPath(path.isAbsolute(out) ? out : path.resolve(cwd, out));
}

/** A full or abbreviated git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_ID = /^[0-9a-f]{4,64}$/i;

/** One working tree of a repository, as `git worktree list --porcelain` reports it. */
export interface GitWorktreeEntry {
  /** The working tree's directory, by {@link canonicalGitPath} (kept as listed when it no longer exists). */
  path: string;
  /** Its HEAD commit; null for a bare repository entry, or a HEAD git did not report. */
  head: string | null;
}

/**
 * Every working tree of the repository `dir` belongs to (the main checkout and
 * each linked worktree, including prunable ones whose directory is gone), in
 * git's order. Null when `dir` is not in a repository or git failed.
 */
export async function listGitWorktrees(dir: string): Promise<GitWorktreeEntry[] | null> {
  const cwd = nearestExistingDirectory(dir);
  if (!cwd) return null;
  const out = await gitAsync(cwd, ['worktree', 'list', '--porcelain']);
  if (out === null) return null;
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  // Porcelain format: one block per worktree, blank-line separated, starting
  // with `worktree <path>`; `HEAD <sha>` follows unless the entry is bare.
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: canonicalGitPath(line.slice('worktree '.length)), head: null };
      entries.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || null;
    } else if (current && line === 'bare') {
      current.head = null;
    }
  }
  return entries;
}

/**
 * Commits in the symmetric difference of two commits (`git rev-list --count
 * a...b`): how far apart two worktrees' HEADs are, in either direction. Null
 * when either commit is unknown to the repository at `dir`, or git failed.
 * Takes object ids only (hex, as `git worktree list` reports HEADs), so no
 * argument can reach git as an option or a revision expression.
 */
export async function commitDistance(dir: string, a: string, b: string): Promise<number | null> {
  if (!OBJECT_ID.test(a) || !OBJECT_ID.test(b)) return null;
  const cwd = nearestExistingDirectory(dir);
  if (!cwd) return null;
  const out = await gitAsync(cwd, ['rev-list', '--count', `${a}...${b}`]);
  if (out === null || !/^\d+$/.test(out)) return null;
  return Number(out);
}
