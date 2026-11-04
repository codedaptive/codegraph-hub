/**
 * Worktree teardown: the housekeeping sweep that reclaims what CodeGraph holds
 * for a registered project (see project-registry.ts) once that project is gone.
 *
 * Without it, a git worktree that got an index seeded from a sibling keeps
 * costing after `git worktree remove`: the MCP server's cached connection
 * (and each query-pool worker's) keeps the deleted database's blocks alive,
 * and the registry entry points at nothing. When the worktree directory outlives the worktree (pruned but not
 * deleted), the seeded index stays on disk too.
 *
 * A registered root R is GONE only on positive evidence, either
 *   1. R's directory does not exist (lstat ENOENT/ENOTDIR), or
 *   2. R's repository, located without running git from inside R, exists, and
 *      `git --git-dir=<common dir> worktree list --porcelain` succeeds and
 *      lists no entry that is the same directory as R's working tree W.
 * W is R itself for a SEEDED root (a seed or a cold build only ever makes an
 * index at a worktree's toplevel). For a root registered only by a pin, which
 * may be a directory inside a worktree, W is the nearest directory at or above
 * R holding a `.git` entry (R when none does), found by stats alone.
 * The repository is located from W's own `.git` file (`gitdir:
 * <common>/worktrees/<name>`, then that directory's `commondir`), else, when W
 * has no `.git` file (no `.git` at all, or a main checkout's `.git`
 * directory), from the recorded common dir. "Same directory" is filesystem
 * identity (device and inode of each listed path against W's), not spelling,
 * so a checkout whose directory changed case, or is spelled another way, is
 * not gone. When the recorded common dir is missing (not recorded, or no
 * longer on disk) but W's `.git` file leads to a repository that lists W, R is
 * live and its record takes that common dir, under the record lock.
 * Anything else is INDETERMINATE: git fails or times out; the repository
 * cannot be located (no `.git` file and no recorded common dir, or a common
 * dir that is not there); W's `.git` cannot be read, names somewhere
 * unreadable, or is no linked worktree's link (a submodule's, a separate git
 * dir's); or a listed worktree cannot be checked. The root is kept as it is
 * and judged again by the next sweep.
 *
 * Tearing a gone root down, in order: release it in this process (the
 * caller's `release`: the tool handler's cache, then the query pool's
 * workers); then,
 * under the root's registry-record lock and only while the record is still
 * the one the sweep read before the release (a root registered again
 * meanwhile, say re-seeded or pinned, is left alone), judge the root AGAIN,
 * there and then: the verdict the release was based on is never acted on. A
 * root live or indeterminate now is kept and stays registered (live, it may
 * take a new common dir as above). Only a root still gone has, under that same
 * lock: `<root>/.codegraph` deleted; and its record removed. The index is deleted only when all of these hold: the
 * root is registered SEEDED; its directory still exists; and the database
 * there holds the seed nonce the record holds (see project-registry.ts), i.e.
 * it is still the index CodeGraph made, not one the user built at that path
 * since. A missing nonce on either side, or a different one, deletes nothing:
 * the root is only unregistered. A step that fails leaves the root
 * registered, so the next sweep tries again. Pinned roots are torn down too: a
 * pin keeps a live project open, it does not keep a removed one.
 *
 * The sweep runs in the index builder (src/extensions/host/builder/), the one
 * process that holds the roots it writes and the only one that deletes an
 * index. The machine server is never signalled or stopped from here. It runs
 * the same pass release-only (housekeeping.ts) and lets go of its read-only
 * handle on a torn-down project within one interval; no per-project daemon,
 * socket or pid file exists to clean up. Stopping the server would make its
 * clients' proxies fall back to a read-only in-process engine until a new
 * server starts.
 *
 * The first process to sweep a gone root unregisters it, so no other process
 * holding that root ever finds it in the registry. Each housekeeping pass
 * ({@link runHousekeepingPass}) therefore also releases the roots THIS process
 * holds open (`TeardownDeps.heldRoots`) whose
 * directory or `codegraph.db` is gone, whoever unregistered them; that release
 * deletes nothing.
 *
 * Git runs with the environment of ./git.ts's `gitEnv` (no GIT_DIR or kin, no
 * injected config), from the filesystem root, with the repository named by
 * `--git-dir`, so neither the environment nor the working directory chooses
 * the repository. The sweep's first judgement of each root runs git through
 * async execFile with a timeout: the sweep runs on the main loop of the index
 * builder, where a blocked loop stalls the IPC requests the server waits on.
 * (The server's release-only pass runs no git.) The judgement again under the record lock
 * (only for a root the first one found gone) runs it synchronously, since the
 * registry's lock is held only within one synchronous call, bounded at
 * {@link GIT_SYNC_TIMEOUT_MS}.
 */
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { canonicalGitPath, gitEnv } from './git';
import {
  listRegisteredProjects,
  readSeedNonce,
  settleProjectIfUnchanged,
  PROJECT_FLAG_SEEDED,
  type RecordSettlement,
  type RegisteredProject,
} from './project-registry';

export interface TeardownDeps {
  /**
   * Close every handle this process holds on `root`. Rejecting
   * skips the root for this sweep (nothing is deleted or unregistered).
   */
  release(root: string): Promise<void>;
  /**
   * The roots this process holds open, canonical. After the sweep, each one whose directory or `codegraph.db` is
   * gone is released, so a root another process tore down and unregistered,
   * or removed by hand, does not stay open here. Absent: the pass releases
   * nothing beyond what the sweep tears down.
   */
  heldRoots?(): string[];
  /**
   * Skip the registry sweep and only release vanished held roots: a
   * read-only server deletes and unregisters nothing, but still lets go of an
   * index that is gone.
   */
  releaseOnly?: boolean;
  /**
   * Runs at the end of every pass, after the release of vanished roots. For the
   * machine server's engine: trim the projects idle past their timeout and run a
   * pass of the pinned-project opener (pinned-open.ts, wired in src/mcp/engine.ts). Synchronous and called inside
   * a try, so a throw is dropped and cannot fail the pass; it must not wait on
   * slow work, because the timer skips a tick while a pass runs. Absent for the
   * index builder's pass.
   */
  afterPass?(): void;
}

/**
 * Default sweep interval: once a minute. Each pass runs one git call per
 * registered root whose directory exists (and one more for each root it finds
 * gone), so it should not run more often; once a minute still frees a removed
 * worktree's database blocks within about a minute.
 */
const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 60_000;

/**
 * Bound on the sweep's first, asynchronous git call per root. The sweep runs
 * off the tool-call path, so it may wait longer than the 5 s the call path
 * allows its git lookups; a git that still has not answered leaves the root
 * as it is.
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Bound on the git call of the judgement under the record lock. It is
 * synchronous, so it blocks the event loop while it runs, as the call path's
 * own synchronous git lookups (src/sync/worktree.ts) do with the same bound:
 * far inside the 60 s liveness watchdog, and short enough that the lock's
 * whole hold stays below the registry's 10 s stale age.
 */
const GIT_SYNC_TIMEOUT_MS = 5_000;

/** Output ceiling for `git worktree list`: ample for thousands of worktrees. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** setInterval's ceiling; a longer delay would fire after 1 ms instead. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `CODEGRAPH_HOUSEKEEPING_INTERVAL_MS`: unset or blank → 60 s; a finite number
 * >= 0 is floored, and `0` disables the sweep; a negative or non-numeric value
 * falls back to the default. Blank is checked after trimming because
 * `Number(' ')` is 0, which would silently disable it.
 */
export function resolveHousekeepingIntervalMs(): number {
  const raw = process.env.CODEGRAPH_HOUSEKEEPING_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOUSEKEEPING_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HOUSEKEEPING_INTERVAL_MS;
  return Math.min(Math.floor(n), MAX_TIMER_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

/** What a judgement of a registered root found (see the file comment). */
type Verdict =
  | { kind: 'gone' }
  /** `commonDir`: the common dir the record should take (its own is missing). */
  | { kind: 'live'; commonDir?: string }
  | { kind: 'indeterminate' };

const GONE: Verdict = { kind: 'gone' };
const LIVE: Verdict = { kind: 'live' };
const INDETERMINATE: Verdict = { kind: 'indeterminate' };

/** A repository located for W without git: its common dir, and whether W's own `.git` file led there. */
interface Located {
  commonDir: string;
  fromGitFile: boolean;
}

/** The git question a judgement still has to ask: list `located`'s worktrees, then look for `worktree`. */
interface Question {
  worktree: string;
  located: Located;
}

/** An lstat error that proves nothing is at the path. Any other (no permission, I/O) proves nothing. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Whether nothing is at `p`: lstat says ENOENT or ENOTDIR (a component of the path is a file). */
function isAbsent(p: string): boolean {
  try {
    fs.lstatSync(p);
    return false;
  } catch (err) {
    return isMissing(err);
  }
}

/** The root itself is a directory, not a symlink to one (lstat). */
function isDirectory(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

/** A directory at `p`, following symlinks (a repository's `.git` may be linked in). */
function isExistingDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * What is at `<dir>/.git`: nothing, a file (a linked worktree's or a
 * submodule's link), a directory (a main checkout's repository), or something
 * that cannot be told (an lstat error other than absence, a symlink whose
 * target cannot be reached, anything else).
 */
function dotGitKind(dir: string): 'missing' | 'file' | 'directory' | 'unknown' {
  const dotGit = path.join(dir, '.git');
  try {
    fs.lstatSync(dotGit);
  } catch (err) {
    return isMissing(err) ? 'missing' : 'unknown';
  }
  try {
    const st = fs.statSync(dotGit);
    if (st.isFile()) return 'file';
    if (st.isDirectory()) return 'directory';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The working tree whose listing decides `rec`: the root itself when it is
 * SEEDED; for a pinned root, the nearest directory at or above it with a
 * `.git` entry (the root when none has). Stats only.
 */
function judgedWorktree(rec: RegisteredProject): string {
  if ((rec.flags & PROJECT_FLAG_SEEDED) !== 0) return rec.root;
  let dir = rec.root;
  for (;;) {
    if (!isAbsent(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return rec.root;
    dir = up;
  }
}

/** The first line of `file`, its trailing whitespace dropped, after `prefix`; null when it does not start so or cannot be read. */
function readPrefixedLine(file: string, prefix: string): string | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const line = (text.split(/\r?\n/)[0] ?? '').replace(/\s+$/, '');
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  return rest === '' ? null : rest;
}

/**
 * The repository of `worktree`, located without git: from its `.git` file
 * when it has one (`gitdir: <dir>`, then `<dir>/commondir`, each relative
 * path resolved as git resolves it), else from `recordedCommonDir`. Null when
 * it cannot be located (see INDETERMINATE in the file comment), or the common
 * dir found is not a directory.
 */
function locateRepository(worktree: string, recordedCommonDir: string | null): Located | null {
  const kind = dotGitKind(worktree);
  if (kind === 'unknown') return null;
  if (kind === 'file') {
    const gitdir = readPrefixedLine(path.join(worktree, '.git'), 'gitdir: ');
    if (gitdir === null) return null;
    const adminDir = path.resolve(worktree, gitdir);
    // Only a linked worktree's administrative directory has a `commondir`.
    const common = readPrefixedLine(path.join(adminDir, 'commondir'), '');
    if (common === null) return null;
    const commonDir = path.resolve(adminDir, common);
    return isExistingDirectory(commonDir) ? { commonDir, fromGitFile: true } : null;
  }
  if (recordedCommonDir === null || !isExistingDirectory(recordedCommonDir)) return null;
  return { commonDir: recordedCommonDir, fromGitFile: false };
}

/** Device and inode of the directory at `p`, by bigint stat; 'missing' when nothing is there, 'unknown' when stat fails otherwise. */
function identityOf(p: string): { dev: bigint; ino: bigint } | 'missing' | 'unknown' {
  try {
    const st = fs.statSync(p, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    return isMissing(err) ? 'missing' : 'unknown';
  }
}

/**
 * The verdict once git listed the located repository's worktrees (`stdout` of
 * `worktree list --porcelain`): live when an entry is the same directory as
 * the question's worktree, gone when none is and every entry was checked,
 * indeterminate otherwise. Porcelain lines carry each path raw, so a worktree
 * whose path holds a line break cannot be found in them: indeterminate.
 */
function verdictFromListing(rec: RegisteredProject, question: Question, stdout: string): Verdict {
  const { worktree, located } = question;
  if (/[\r\n]/.test(worktree)) return INDETERMINATE;
  const self = identityOf(worktree);
  // An inode of 0 identifies nothing (some filesystems report no inodes).
  if (typeof self === 'string' || self.ino === 0n) return INDETERMINATE;
  let listed = false;
  let unchecked = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const entry = line.slice('worktree '.length);
    if (!path.isAbsolute(entry)) { unchecked = true; continue; }
    const id = identityOf(entry);
    if (id === 'missing') continue; // a prunable entry: not this directory
    if (id === 'unknown' || id.ino === 0n) { unchecked = true; continue; }
    if (id.dev === self.dev && id.ino === self.ino) { listed = true; break; }
  }
  if (!listed) return unchecked ? INDETERMINATE : GONE;
  if (located.fromGitFile && (rec.commonDir === null || isAbsent(rec.commonDir))) {
    return { kind: 'live', commonDir: canonicalGitPath(located.commonDir) };
  }
  return LIVE;
}

/** The verdict reached without git (the root's directory missing; no repository to ask), or the question git must answer. */
function prepareJudgement(rec: RegisteredProject): Verdict | Question {
  if (isAbsent(rec.root)) return GONE;
  const worktree = judgedWorktree(rec);
  const located = locateRepository(worktree, rec.commonDir);
  return located ? { worktree, located } : INDETERMINATE;
}

function isQuestion(v: Verdict | Question): v is Question {
  return 'worktree' in v;
}

/** `git worktree list --porcelain` of the repository at `commonDir`, asynchronously; null when git fails or times out. */
function listWorktrees(commonDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', [`--git-dir=${commonDir}`, 'worktree', 'list', '--porcelain'], {
        cwd: path.parse(commonDir).root,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
        // No optional locks: a read-only probe never takes index.lock.
        env: gitEnv({ GIT_OPTIONAL_LOCKS: '0' }),
      }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

/** {@link listWorktrees}, synchronously, bounded at {@link GIT_SYNC_TIMEOUT_MS}. */
function listWorktreesNow(commonDir: string): string | null {
  try {
    return execFileSync('git', [`--git-dir=${commonDir}`, 'worktree', 'list', '--porcelain'], {
      cwd: path.parse(commonDir).root,
      timeout: GIT_SYNC_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv({ GIT_OPTIONAL_LOCKS: '0' }),
    });
  } catch {
    return null;
  }
}

/** Judge `rec` (see the file comment), git asynchronously: the sweep's first look at each root. */
async function judge(rec: RegisteredProject): Promise<Verdict> {
  const step = prepareJudgement(rec);
  if (!isQuestion(step)) return step;
  const stdout = await listWorktrees(step.located.commonDir);
  return stdout === null ? INDETERMINATE : verdictFromListing(rec, step, stdout);
}

/** Judge `rec` again, git synchronously: under the record lock, right before any destructive step. */
function judgeNow(rec: RegisteredProject): Verdict {
  const step = prepareJudgement(rec);
  if (!isQuestion(step)) return step;
  const stdout = listWorktreesNow(step.located.commonDir);
  return stdout === null ? INDETERMINATE : verdictFromListing(rec, step, stdout);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Whether the index at `rec.root` is the one CodeGraph made there: the
 * record carries a seed nonce and the database there holds the same one.
 * Read read-only; a database that cannot be read proves nothing.
 */
function isRecordedSeed(rec: RegisteredProject): boolean {
  return !!rec.seedNonce && readSeedNonce(rec.root) === rec.seedNonce;
}

/**
 * Tear down one root the sweep judged gone, `rec` being its record as the
 * sweep read it before judging it. True when this call unregistered it.
 * False when it stays registered: the release failed or a step failed (the
 * next sweep tries again); the root was registered again while its release
 * was awaited (another seed of the root, a pin), which makes it a live
 * registration this sweep never judged; the judgement again under the record
 * lock found it live (perhaps taking a new common dir) or could not tell; or
 * another process tore it down meanwhile.
 */
async function tearDown(rec: RegisteredProject, deps: TeardownDeps): Promise<boolean> {
  const root = rec.root;
  try {
    await deps.release(root);
  } catch (err) {
    warn(root, `could not release ${root}: ${message(err)}`);
    return false;
  }
  try {
    // Under the record's lock, and only while the record is still `rec`:
    // nothing can register the root again between this judgement, the
    // deletion and the unregistration.
    const outcome = settleProjectIfUnchanged(rec, (): RecordSettlement => {
      const now = judgeNow(rec);
      if (now.kind === 'live' && now.commonDir) return { action: 'update-common-dir', commonDir: now.commonDir };
      if (now.kind !== 'gone') return { action: 'keep' };
      const dirPresent = isDirectory(root);
      // Only CodeGraph's own seeded index, still the very database it made: an
      // index the user built at this path since is never deleted.
      if (dirPresent && (rec.flags & PROJECT_FLAG_SEEDED) !== 0 && isRecordedSeed(rec)) {
        fs.rmSync(getCodeGraphDir(root), { recursive: true, force: true });
      }
      return { action: 'remove' };
    });
    return outcome === 'removed';
  } catch (err) {
    warn(root, `could not tear down ${root}: ${message(err)}`);
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Each root's failure is reported once per process: a root that cannot be
// torn down (say, an index Windows will not delete while another process
// still has it open) is retried every sweep, and one line a minute about it
// would drown the log.
const warnedRoots = new Set<string>();

function warn(root: string, text: string): void {
  if (warnedRoots.has(root)) return;
  warnedRoots.add(root);
  process.stderr.write(`[CodeGraph] Housekeeping: ${text}\n`);
}

/**
 * One sweep over the registry: tear down every registered root that is gone,
 * and give a live root whose recorded common dir is missing the one its
 * `.git` leads to. Roots are handled one at a time. Resolves with the roots
 * this sweep unregistered; never rejects (a root whose check or teardown
 * fails, or whose verdict is indeterminate, is left for the next sweep, and
 * one registered again during its teardown is kept). It sees only roots still
 * registered: one another process already tore down is released here by
 * {@link runHousekeepingPass}, not by the sweep.
 */
export async function sweepWorktrees(deps: TeardownDeps): Promise<string[]> {
  const torn: string[] = [];
  for (const rec of listRegisteredProjects()) {
    try {
      const verdict = await judge(rec);
      if (verdict.kind === 'gone') {
        if (await tearDown(rec, deps)) torn.push(rec.root);
      } else if (verdict.kind === 'live' && verdict.commonDir) {
        const commonDir = verdict.commonDir;
        settleProjectIfUnchanged(rec, () => ({ action: 'update-common-dir', commonDir }));
      }
    } catch (err) {
      warn(rec.root, `teardown of ${rec.root} failed: ${message(err)}`);
    }
  }
  return torn;
}

/**
 * Whether the index `root` was opened from is gone: the directory, or its
 * `codegraph.db`, no longer exists (another process's teardown deleted it,
 * `git worktree remove` took the directory, or it was removed by hand).
 */
function indexVanished(root: string): boolean {
  return !fs.existsSync(root) || !fs.existsSync(path.join(getCodeGraphDir(root), 'codegraph.db'));
}

/**
 * Release each root in `deps.heldRoots()` whose index is gone, one at a time.
 * Never rejects: a root whose release fails stays held and is tried again on
 * the next pass.
 */
async function releaseVanishedRoots(deps: TeardownDeps): Promise<void> {
  if (!deps.heldRoots) return;
  let roots: string[];
  try { roots = deps.heldRoots(); } catch { return; }
  for (const root of roots) {
    if (!indexVanished(root)) continue;
    try {
      await deps.release(root);
    } catch (err) {
      warn(root, `could not release ${root}: ${message(err)}`);
    }
  }
}

/**
 * One housekeeping pass: {@link sweepWorktrees} (skipped with
 * `deps.releaseOnly`), then the release of every held root whose directory or
 * database is gone (see {@link TeardownDeps.heldRoots}), then
 * {@link TeardownDeps.afterPass}. Never rejects.
 */
export async function runHousekeepingPass(deps: TeardownDeps): Promise<void> {
  if (!deps.releaseOnly) await sweepWorktrees(deps);
  await releaseVanishedRoots(deps);
  try { deps.afterPass?.(); } catch { /* the hook is best-effort; the pass is done */ }
}

/**
 * Run {@link runHousekeepingPass} every `intervalMs` (default
 * {@link resolveHousekeepingIntervalMs}; `0` or less starts nothing). The
 * timer is unref'd, so it never keeps the process alive, and a pass still
 * running when the next tick comes skips that tick. Returns the stop function.
 */
export function startHousekeeping(deps: TeardownDeps, intervalMs: number = resolveHousekeepingIntervalMs()): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => { /* nothing started */ };
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void runHousekeepingPass(deps).finally(() => { running = false; });
  }, Math.min(Math.floor(intervalMs), MAX_TIMER_DELAY_MS));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
