/**
 * Worktree seeding: give a fresh git worktree its own index on the first
 * MCP tool call that names it, by copying the index of its nearest indexed
 * sibling worktree, instead of telling the agent the project is not indexed
 * (or silently serving the parent checkout's index, #155).
 *
 * The server calls {@link ensureWorktreeIndex} on the async path of a tool
 * call (`ToolHandler.awaitProjectGate`, src/mcp/tools.ts), and only when it owns a project
 * lifecycle (the machine server's engine). The CLI and the query-pool workers
 * never seed. Nothing here touches the agent's code: the only writes are a new
 * `.codegraph/` in the worktree and a record in the project registry.
 *
 * When it runs: `projectPath` is inside git worktree W and the nearest
 * `.codegraph/` is not W's own, i.e. there is none, or it is another worktree
 * of the SAME repository (the borrowed-index case). An index at or below W
 * changes nothing: a stat walk from `projectPath` up to the index finds no
 * `.git` below it, so no git runs at all; past that walk, the toplevel lookup
 * is one memoized `git rev-parse --show-toplevel`.
 *
 * What it does:
 *   - seed: the sibling worktree with a complete index whose HEAD
 *     is the fewest commits from W's, ties by realpath, has its database
 *     copied into W. The copy is an APFS clone (`cp -c`) on macOS, a plain copy
 *     elsewhere, both taken under the source's `codegraph.lock` after a
 *     TRUNCATE checkpoint, or a SQLite online backup when the source cannot be
 *     fenced. W gets `codegraph.db`, an empty WAL and `.gitignore`, nothing
 *     else. The copy carries a fresh seed nonce, and W is registered SEEDED
 *     with that nonce, so teardown can reclaim this index and only this one
 *     (project-registry.ts). The caller's
 *     catch-up sync then re-indexes only the files that differ (rows store
 *     project-relative paths, so the copied rows are valid in W).
 *     A seed that fails while a sibling qualifies (W's index locked by
 *     another process past the retries, the copy failing) never falls back to
 *     a cold build: the call answers the not-indexed guidance, and the next
 *     call tries the seed again.
 *   - cold build: no sibling to copy, and the user opted in
 *     (`CODEGRAPH_AUTO_INDEX=1`, or the registry already holds a project of
 *     this repository). A detached child (`cold-build.ts`) holds `rebuild.pid`
 *     for the whole init + index, and calls for W answer {@link buildingNote}
 *     meanwhile. It registers W SEEDED, with the nonce it wrote into the built
 *     index, once built. A child killed by a signal
 *     is not a failed build: the next call may start another.
 *   - otherwise nothing: the existing not-indexed guidance stands, because
 *     indexing a repository nobody indexed is the user's decision.
 *
 * An index of W's own that a killed build left behind (`index_state` read and
 * found other than 'complete', a `rebuild.pid` whose holder is dead, no live
 * writer) counts as no index: when a seed or a cold build can replace it, its
 * `.codegraph/` contents are discarded first, under W's `rebuild.pid` and
 * `codegraph.lock`. One whose state cannot be read is kept as it is.
 * A seeder killed mid-copy leaves `codegraph.db.seed-<pid>-<hex>.tmp`; the
 * next seed of W removes each one whose pid is dead.
 *
 * `CODEGRAPH_NO_AUTO_SEED=1` turns all of it off.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import {
  canonicalProjectRoot,
  createDirectory,
  findNearestCodeGraphRoot,
  getCodeGraphDir,
  isInitialized,
  unsafeIndexRootReason,
} from '../../../directory';
import { FileLock, validateProjectPath } from '../../../utils';
import { loadNodeSqlite, type NodeSqliteModule } from '../../../db/node-sqlite';
import { NODE_RUNTIME_FLAGS, WASM_RUNTIME_FLAGS } from '../../../extraction/wasm-runtime-flags';
import {
  commitDistance,
  gitCommonDirAsync,
  gitWorktreeRootAsync,
  gitWorktreeRootMayBeBelow,
  listGitWorktrees,
  type GitWorktreeEntry,
} from './git';
import {
  isForeignLockRecord,
  isRebuildInProgress,
  lockStamp,
  readWriterLock,
  releaseWriterLock,
  tryAcquireWriterLock,
} from '../../../mcp/writer-lock';
import { isProcessAlive } from '../../../mcp/server-control';
import { hasRegisteredRepository, registerProject, stampSeedNonce } from './project-registry';

export type SeedMethod = 'clone' | 'copy' | 'backup';

/** What {@link seedFromSibling} installed. */
export interface SeedResult {
  method: SeedMethod;
  /** The seed nonce written into the installed database, for the registry record. */
  nonce: string;
}

export type SeedOutcome =
  | { kind: 'seeded'; root: string; source: string; method: SeedMethod }
  | { kind: 'building'; root: string }
  // `worktree` is set when projectPath is in a git worktree this module
  // considered (no index of its own) but could neither seed nor build: the
  // caller's not-indexed answer can then say a seed may still follow, rather
  // than "never call again".
  | { kind: 'none'; worktree?: string };

const NONE: SeedOutcome = { kind: 'none' };

/** The kill switch. Read per call, so a test or an operator can flip it live. */
function seedingDisabled(): boolean {
  return process.env.CODEGRAPH_NO_AUTO_SEED === '1';
}

/** The user's explicit opt-in to a cold build of an un-indexed worktree. */
function autoIndexOptedIn(): boolean {
  return process.env.CODEGRAPH_AUTO_INDEX === '1';
}

// ---------------------------------------------------------------------------
// Worktree lookup (one memoized toplevel lookup per path)
// ---------------------------------------------------------------------------

/**
 * `git rev-parse --show-toplevel` per start directory. Keyed by the resolved
 * path, and remembered only when that path exists. A cached answer, null
 * included, is kept until the memo is cleared, so a directory that becomes a
 * working tree later (`git init`, `git worktree add` into it) is seen only
 * after a clear. Bounded: a long-lived daemon queried with many paths drops
 * the whole memo and starts over rather than grow; 512 is ample because only
 * paths that pass the git-free pre-check reach this lookup, and a clear costs
 * one more `git rev-parse` per path.
 */
const TOPLEVEL_MEMO_MAX = 512;
const toplevelMemo = new Map<string, Promise<string | null>>();

function worktreeRootOf(projectPath: string): Promise<string | null> {
  const key = path.resolve(projectPath);
  let hit = toplevelMemo.get(key);
  if (!hit) {
    if (toplevelMemo.size >= TOPLEVEL_MEMO_MAX) toplevelMemo.clear();
    hit = gitWorktreeRootAsync(key);
    // A path that does not exist yet may become a worktree later: remember
    // only answers about an existing path.
    if (fs.existsSync(key)) toplevelMemo.set(key, hit);
  }
  return hit;
}

/** `child` is `parent` or below it (both canonical). */
function isAtOrBelow(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sameRoot(a: string, b: string): boolean {
  return a === b || canonicalProjectRoot(a) === canonicalProjectRoot(b);
}

// ---------------------------------------------------------------------------
// Source choice
// ---------------------------------------------------------------------------

/**
 * Whether `root` holds a database whose index finished (`index_state` is
 * 'complete') and is not being rebuilt. A database that cannot be read is not
 * a source. One read-only open and a primary-key lookup.
 */
function hasCompleteIndex(root: string): boolean {
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!fs.existsSync(dbFile)) return false;
  if (isRebuildInProgress(root)) return false;
  const state = readIndexState(dbFile);
  return state.read && state.value === 'complete';
}

/**
 * The `index_state` of a database as read, or that it could not be read.
 * `value` is null when the read found no state: no database file, no
 * `project_metadata` table (a build killed before its schema), or no
 * `index_state` row (one killed before marking it).
 */
type IndexStateRead = { read: true; value: string | null } | { read: false };

/**
 * `index_state` of the database `dbFile`, read-only. `{ read: false }` when
 * the database cannot be opened or queried (no permission, locked, corrupt):
 * an unreadable state says nothing about whether the build finished.
 */
function readIndexState(dbFile: string): IndexStateRead {
  if (!fs.existsSync(dbFile)) return { read: true, value: null };
  let db: { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void } | null = null;
  try {
    db = new (loadNodeSqlite().DatabaseSync)(dbFile, { readOnly: true });
    const table = db!.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'project_metadata'").get();
    if (table === undefined) return { read: true, value: null };
    const row = db!.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get() as { value?: unknown } | undefined;
    return { read: true, value: typeof row?.value === 'string' ? row.value : null };
  } catch {
    return { read: false };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Whether `dbFile`'s build positively did not finish: its state was read and
 * is not 'complete'. A state that cannot be read is never taken for an
 * unfinished one.
 */
function isUnfinishedIndex(dbFile: string): boolean {
  const state = readIndexState(dbFile);
  return state.read && state.value !== 'complete';
}

// ---------------------------------------------------------------------------
// What a killed build or seeder left behind
// ---------------------------------------------------------------------------

/**
 * Whether `root`'s own index is one a killed build left behind: a
 * `rebuild.pid` whose holder is dead (absent from `isRebuildInProgress`'s
 * view, and not this process), no live `writer.pid` holder, and an
 * `index_state` read and found other than 'complete' ({@link isUnfinishedIndex}).
 * A killed child leaves 'indexing', or no state at all when it died between
 * creating the schema and marking it. A database whose state cannot be read
 * (no permission, locked) is not abandoned: nothing shows its build was
 * killed. The first test is one stat, so a finished index costs nothing more
 * per call; without a `rebuild.pid` nothing is judged abandoned, because a running
 * `codegraph init` (which takes no `rebuild.pid`) looks the same from outside.
 * `root` must be a checkout root (a `.git` entry there): an index of a plain
 * directory is never replaced.
 */
function isAbandonedIndex(root: string): boolean {
  const dir = getCodeGraphDir(root);
  if (!fs.existsSync(path.join(dir, 'rebuild.pid'))) return false;
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const rebuild = readWriterLock(root, 'rebuild.pid');
  if (rebuild?.pid === process.pid || isRebuildInProgress(root)) return false;
  const writer = readWriterLock(root);
  if (writer && writer.pid > 0 && isProcessAlive(writer.pid)) return false;
  return isUnfinishedIndex(path.join(dir, 'codegraph.db'));
}

/**
 * Discard the abandoned index of `root` (see {@link isAbandonedIndex}): take
 * its `rebuild.pid` (so no reader opens it meanwhile) and its `codegraph.lock`
 * (so no writer is mid-index), check again (a live writer, or a state no
 * longer read as unfinished, keeps it), then remove everything in its
 * `.codegraph/` but `.gitignore` and those two locks, and release them. True
 * when the index is gone (it may already have been); false when a live
 * process holds either lock or the index turned out not to be abandoned.
 */
function discardAbandonedIndex(root: string): boolean {
  const dir = getCodeGraphDir(root);
  if (!fs.existsSync(path.join(dir, 'codegraph.db'))) return true;
  const rebuild = tryAcquireWriterLock(root, 'seed', 'rebuild.pid');
  if (rebuild.kind === 'taken') return false;
  const lock = new FileLock(path.join(dir, 'codegraph.lock'), lockOwner(root));
  try {
    try { lock.acquire(); } catch { return false; }
    const writer = readWriterLock(root);
    if (writer && writer.pid > 0 && writer.pid !== process.pid && isProcessAlive(writer.pid)) return false;
    if (!isUnfinishedIndex(path.join(dir, 'codegraph.db'))) return false;
    const keep = new Set(['.gitignore', 'rebuild.pid', 'codegraph.lock']);
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    process.stderr.write(`[CodeGraph MCP] Discarded the unfinished index of ${root} (its build was killed).\n`);
    return true;
  } catch {
    return false;
  } finally {
    lock.release();
    releaseWriterLock(root, 'rebuild.pid');
  }
}

/** A seeder's staging copy: `codegraph.db.seed-<pid>-<hex>.tmp` and SQLite's side files for it. */
const SEED_STAGING_NAME = /^codegraph\.db\.seed-(\d+)-[0-9a-f]+\.tmp(?:-journal|-wal|-shm)?$/;

/**
 * Remove the staging copies in `dir` whose seeder is dead (killed mid-copy).
 * One whose pid is alive may be a copy in progress and is kept; so is this
 * process's own.
 */
function removeDeadSeedStaging(dir: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = SEED_STAGING_NAME.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || (pid > 0 && isProcessAlive(pid))) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* gone meanwhile */ }
  }
}

/** How many `git rev-list --count` runs at once: enough to overlap, never a fork storm. */
const DISTANCE_CONCURRENCY = 4;

async function pickFromEntries(worktreeRoot: string, entries: GitWorktreeEntry[]): Promise<string | null> {
  const self = entries.find((e) => sameRoot(e.path, worktreeRoot));
  const candidates = entries.filter((e) => !sameRoot(e.path, worktreeRoot) && hasCompleteIndex(e.path));
  const scored: Array<{ path: string; distance: number | null }> = [];
  for (let i = 0; i < candidates.length; i += DISTANCE_CONCURRENCY) {
    const batch = candidates.slice(i, i + DISTANCE_CONCURRENCY);
    scored.push(...await Promise.all(batch.map(async (e) => ({
      path: e.path,
      distance: self?.head && e.head ? await commitDistance(worktreeRoot, self.head, e.head) : null,
    }))));
  }
  // Fewest commits first; a distance git could not compute sorts after every
  // computable one; ties by realpath, plain code-unit order ascending.
  scored.sort((a, b) => {
    if (a.distance !== b.distance) {
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored[0]?.path ?? null;
}

/**
 * The sibling worktree to seed `worktreeRoot` from, canonical (git.ts), or null
 * when no other worktree of its repository has a complete index.
 */
export async function pickSeedSource(worktreeRoot: string): Promise<string | null> {
  const root = (await gitWorktreeRootAsync(worktreeRoot)) ?? path.resolve(worktreeRoot);
  const entries = await listGitWorktrees(root);
  if (!entries) return null;
  return pickFromEntries(root, entries);
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/** The `FileLock` owner every CodeGraph instance uses for `codegraph.lock` (src/index.ts). */
function lockOwner(root: string) {
  return { stamp: () => lockStamp(root), isForeign: (r: unknown) => isForeignLockRecord(r, root) };
}

/**
 * A short bounded retry: a CodeGraph writer holds `codegraph.lock`
 * across one sync's writes, normally well under a second. Past this, the
 * source is busy and the seed takes the backup path instead of waiting.
 */
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_MS = 100;

async function acquireWithRetry(lock: FileLock): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      lock.acquire();
      return true;
    } catch {
      if (attempt < LOCK_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  return false;
}

/**
 * How long the fenced checkpoint may wait for a reader or writer that does
 * not honor `codegraph.lock`. It runs synchronously on the server's main
 * thread, so it stays short; past it, `busy` is reported and the seed falls
 * back to a backup.
 */
const CHECKPOINT_BUSY_TIMEOUT_MS = 250;

/** Bound on `cp -c`. A clone is metadata-only; this only catches a hung cp. */
const CLONE_TIMEOUT_MS = 60_000;

/**
 * Pages per `backup()` step: more than any index has, so the whole copy is ONE
 * step under one read transaction, a consistent snapshot even while another
 * connection writes. Several smaller steps would restart whenever the source
 * changed between them, and against a busy writer might never finish.
 */
const BACKUP_ALL_PAGES = 1_000_000_000;

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
  close(): void;
};
type SqliteWithBackup = NodeSqliteModule & {
  backup?: (source: unknown, destination: string, options?: { rate?: number }) => Promise<number>;
};

function walSize(dbFile: string): number {
  try {
    return fs.statSync(`${dbFile}-wal`).size;
  } catch {
    return 0;
  }
}

/** Clone `src` to `dst` on macOS (APFS clonefile via `cp -c`); copy anywhere else or when that fails. */
async function cloneOrCopy(src: string, dst: string): Promise<'clone' | 'copy'> {
  if (process.platform === 'darwin') {
    // Node's COPYFILE_FICLONE makes a full copy on macOS, so it is not the
    // clone path: `cp -c` calls clonefile(2) and shares the blocks.
    const cloned = await new Promise<boolean>((resolve) => {
      execFile('/bin/cp', ['-c', src, dst], { timeout: CLONE_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err));
    });
    if (cloned) return 'clone';
    try { fs.unlinkSync(dst); } catch { /* cp left nothing */ }
  }
  await fs.promises.copyFile(src, dst);
  return 'copy';
}

/**
 * Snapshot the source database into `tmp` under the fence, or return
 * null when the fence cannot be taken cleanly (the caller then backs up).
 *
 * Under the source's `codegraph.lock` no CodeGraph writer runs. The TRUNCATE
 * checkpoint folds the WAL into the main file; `busy = 0` means it completed.
 * A read transaction is then opened before the copy and held across it: it
 * starts on the main file alone (SQLite's read lock 0, the WAL being empty),
 * and while it is held no checkpoint may write WAL frames back into the main
 * file, so the file being copied cannot change even under a writer that does
 * not honor `codegraph.lock`. Such a writer may still append to the WAL
 * between the checkpoint and the read; the WAL-size check after the read
 * starts catches that, and the seed falls back.
 */
async function fencedSnapshot(sourceRoot: string, srcDb: string, tmp: string): Promise<'clone' | 'copy' | null> {
  const lock = new FileLock(path.join(getCodeGraphDir(sourceRoot), 'codegraph.lock'), lockOwner(sourceRoot));
  if (!(await acquireWithRetry(lock))) return null;
  let db: SqliteDb | null = null;
  try {
    db = new (loadNodeSqlite().DatabaseSync)(srcDb) as SqliteDb;
    db.exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_TIMEOUT_MS}`);
    const ck = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
    if (!ck || ck.busy !== 0) return null;
    db.exec('BEGIN');
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      if (walSize(srcDb) !== 0) return null;
      return await cloneOrCopy(srcDb, tmp);
    } finally {
      try { db.exec('ROLLBACK'); } catch { /* no transaction left */ }
    }
  } catch {
    return null;
  } finally {
    // The connection stayed open through the clone, its read transaction
    // pinning the main file. Release the lock before closing it: the fence is
    // needed only until the copy ends (the read transaction is already rolled
    // back), and the close may run SQLite's close-time checkpoint, which need
    // not hold the source's writers off.
    lock.release();
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** The unfenced path: SQLite's online backup, a full copy taken in one read transaction. */
async function backupSnapshot(srcDb: string, tmp: string): Promise<void> {
  const sqlite = loadNodeSqlite() as SqliteWithBackup;
  const db = new sqlite.DatabaseSync(srcDb) as SqliteDb;
  try {
    // The backup (or VACUUM INTO) runs as one step, so it needs the source's
    // read lock once: 5 s rides out a writer's commit holding it off without
    // holding the call much longer than that commit.
    db.exec('PRAGMA busy_timeout = 5000');
    if (typeof sqlite.backup === 'function') {
      await sqlite.backup(db, tmp, { rate: BACKUP_ALL_PAGES });
    } else {
      // node:sqlite before backup() (Node < 22.16): VACUUM INTO is likewise
      // one consistent read of the source into a new file.
      db.prepare('VACUUM INTO ?').run(tmp);
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Thrown when the target gained an index while the seed was being taken. */
class SeedTargetTakenError extends Error {
  constructor(root: string) {
    super(`${root} already has an index`);
    this.name = 'SeedTargetTakenError';
  }
}

/**
 * A file this seeder wrote into the target, as it wrote it: its identity
 * (device and inode) and its bytes. A failed seed removes it only while both
 * still match, so a file another process put at the same name since (its own
 * `.gitignore`, the WAL of a database it installed) is never taken for ours.
 */
interface OwnFile {
  file: string;
  dev: bigint;
  ino: bigint;
  content: Buffer;
}

function snapshotOwnFile(file: string): OwnFile | null {
  try {
    const st = fs.statSync(file, { bigint: true });
    return { file, dev: st.dev, ino: st.ino, content: fs.readFileSync(file) };
  } catch {
    return null;
  }
}

/** Remove `own.file` if it is still the file this seeder wrote (see {@link OwnFile}). */
function removeIfStillOwn(own: OwnFile | null): void {
  if (!own) return;
  const now = snapshotOwnFile(own.file);
  if (!now || now.dev !== own.dev || now.ino !== own.ino || !now.content.equals(own.content)) return;
  try { fs.unlinkSync(own.file); } catch { /* gone meanwhile */ }
}

/**
 * Give the target's `.codegraph/` a `.gitignore` when it has none: the
 * source's, else CodeGraph's standard one. Created exclusively, so one already
 * there (another initializer's, a user's) is left exactly as it is. Returns
 * the file this call created, or null when it created none.
 */
function writeTargetGitignore(srcDir: string, dstDir: string): OwnFile | null {
  const dst = path.join(dstDir, '.gitignore');
  const src = path.join(srcDir, '.gitignore');
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    } else {
      fs.writeFileSync(dst, standardGitignore(), { flag: 'wx' });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  return snapshotOwnFile(dst);
}

/**
 * The `.gitignore` CodeGraph writes into a new `.codegraph/`, read from a
 * throwaway directory `createDirectory` initializes, so this module never
 * keeps a second copy of its text. Used only when the source has none.
 */
function standardGitignore(): Buffer {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
  try {
    createDirectory(scratch);
    return fs.readFileSync(path.join(getCodeGraphDir(scratch), '.gitignore'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Copy `sourceRoot`'s index into `targetRoot` (both worktree roots) and say
 * how, and with which seed nonce. The target ends with exactly
 * `codegraph.db`, an empty `codegraph.db-wal` and `.gitignore` (one already
 * there, else the source's, else CodeGraph's standard one): no pid file, lock,
 * socket, log or `-shm` crosses over.
 *
 * The copy is staged under a temporary name and linked into place under the
 * TARGET's `codegraph.lock`, never over an existing database, so a reader
 * never sees a half-written file and two seeders of one worktree cannot both
 * install. Under that lock, before the link, a fresh seed nonce is written
 * into the staged copy ({@link stampSeedNonce}), so the database at the path
 * carries it from its first moment; the caller records it in the registry. A
 * staging copy a killed seeder left in the target (its pid dead) is removed
 * first. Throws when the source has no index, when the target already has an
 * index, when the target's `codegraph.lock` stays held by another process past
 * the retries, or when the copy or the nonce write fails.
 *
 * A seed that fails removes what it made and nothing else, since other
 * processes (another seeder, a `codegraph init`, a server) may have put files
 * in the same `.codegraph/` meanwhile: its staged copy and that copy's side
 * files (named by its pid and a random tag, so never another's); the empty WAL
 * it wrote, while still that file ({@link OwnFile}) and no database is at the
 * path; and the `.gitignore` it wrote, while still that file, no database is
 * at the path, and this seed holds the target's `codegraph.lock` (a process
 * holding it may be installing an index that relies on that `.gitignore`, so
 * then it stays: it is CodeGraph's own ignore file, harmless). The cleanup runs
 * under that lock: the one the install held, or, for a seed that failed before
 * it, the lock taken once more for the cleanup; when another process holds
 * it, only the staged copy and its side files go (a seed that never took the
 * lock wrote no WAL), and the `.gitignore` stays. Last, the `.codegraph/` directory
 * itself, if this seed created it, with `rmdir`: only when nothing else is
 * left in it. An install that finds no `.gitignore` (another seed's cleanup
 * removed the one it relied on) writes it again under the lock.
 */
export async function seedFromSibling(targetRoot: string, sourceRoot: string): Promise<SeedResult> {
  const srcDir = getCodeGraphDir(sourceRoot);
  const srcDb = path.join(srcDir, 'codegraph.db');
  if (!fs.existsSync(srcDb)) throw new Error(`${sourceRoot} has no index to seed from`);
  if (isInitialized(targetRoot)) throw new SeedTargetTakenError(targetRoot);

  const dstDir = getCodeGraphDir(targetRoot);
  const dstDb = path.join(dstDir, 'codegraph.db');
  // Whether this seed made the directory: a plain mkdir fails with EEXIST
  // when anyone else did, so the answer holds even against a concurrent one.
  let createdDir = false;
  try {
    fs.mkdirSync(dstDir);
    createdDir = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const tmp = path.join(dstDir, `codegraph.db.seed-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const scratch = [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`];
  let ownIgnore: OwnFile | null = null;
  let ownWal: OwnFile | null = null;
  let installed = false;
  let cleaned = false;
  const targetLock = new FileLock(path.join(dstDir, 'codegraph.lock'), lockOwner(targetRoot));
  // The files a failed seed removes (see above), `locked` when this seed holds
  // the target lock. The directory goes afterwards, once the lock file in it
  // is released.
  const removeOwnFiles = (locked: boolean) => {
    cleaned = true;
    for (const f of scratch) {
      try { fs.unlinkSync(f); } catch { /* not there */ }
    }
    if (fs.existsSync(dstDb)) return;
    removeIfStillOwn(ownWal);
    if (locked) removeIfStillOwn(ownIgnore);
  };
  try {
    removeDeadSeedStaging(dstDir);
    // Before the copy is staged, so the worktree's git never lists it.
    ownIgnore = writeTargetGitignore(srcDir, dstDir);
    let method: SeedMethod | null = await fencedSnapshot(sourceRoot, srcDb, tmp);
    if (method === null) {
      try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
      await backupSnapshot(srcDb, tmp);
      method = 'backup';
    }

    if (!(await acquireWithRetry(targetLock))) throw new Error(`${targetRoot}'s index is locked by another process`);
    let nonce: string;
    try {
      if (fs.existsSync(dstDb)) throw new SeedTargetTakenError(targetRoot);
      ownIgnore = writeTargetGitignore(srcDir, dstDir) ?? ownIgnore;
      // The staged copy is this seeder's alone; its own side files are
      // checkpointed away by the write and removed with the scratch.
      nonce = stampSeedNonce(tmp);
      // No database yet, so any WAL or shm here is left over from an earlier
      // one; SQLite would replay a stale WAL into the new file.
      for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${dstDb}${suffix}`, { force: true });
      fs.writeFileSync(`${dstDb}-wal`, '', { flag: 'wx' });
      ownWal = snapshotOwnFile(`${dstDb}-wal`);
      try {
        fs.linkSync(tmp, dstDb); // fails rather than replace a database
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new SeedTargetTakenError(targetRoot);
        fs.renameSync(tmp, dstDb); // no hard links here; the lock and the check above stand in
      }
      // One name only: a database with a second link reads as shared to the
      // copied-lock checks (isForeignLockRecord).
      try { fs.unlinkSync(tmp); } catch { /* renamed */ }
      installed = true;
    } finally {
      // Still under the lock the install took.
      if (!installed) removeOwnFiles(true);
      targetLock.release();
    }
    return { method, nonce };
  } finally {
    if (installed) {
      for (const f of scratch) {
        try { fs.unlinkSync(f); } catch { /* not there */ }
      }
    } else {
      if (!cleaned) {
        // Failed before the install took the lock: take it for the cleanup
        // if it is free (one attempt; held by another process, the cleanup
        // leaves that process's possible install what it may rely on).
        let locked = false;
        try {
          targetLock.acquire();
          locked = true;
        } catch { /* held elsewhere */ }
        try {
          removeOwnFiles(locked);
        } finally {
          if (locked) targetLock.release();
        }
      }
      // Only an empty directory goes: anything another process put there stays.
      if (createdDir) {
        try { fs.rmdirSync(dstDir); } catch { /* not empty, or gone */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cold build
// ---------------------------------------------------------------------------

/** Cold builds this process started, by canonical root, while the child runs. */
const builds = new Map<string, string>();
/**
 * Roots whose cold build failed in this process (the child exited non-zero):
 * not retried on every call. A child ended by a signal is not recorded: it was
 * killed, not failed, and the next call builds again.
 */
const failedBuilds = new Set<string>();

/** Whether this process is cold-building the index of `root` right now. */
export function isBuilding(root: string): boolean {
  return builds.has(canonicalProjectRoot(root));
}

/**
 * The answer a tool call for a worktree gets while its index is built. A
 * success-shaped note: never "not indexed" (it soon will be) and never an
 * empty result (nothing has been searched).
 */
export function buildingNote(root: string): string {
  return (
    `CodeGraph is building the index for ${root} (a git worktree with no index ` +
    'of its own and no indexed worktree to copy one from). It is not ready yet; ' +
    'use your built-in tools (Read/Grep/Glob) for this codebase meanwhile, and ' +
    'retry codegraph here in a minute.'
  );
}

/**
 * The not-indexed guidance for `projectPath`, inside git worktree `worktree`,
 * when {@link ensureWorktreeIndex} could neither seed it nor build it. A later
 * call tries again (it copies a sibling's index once one is complete, and
 * retries a copy that failed), so the plain "not indexed" guidance, which
 * tells the agent never to call again, would be wrong there.
 */
export function unseededWorktreeNote(projectPath: string, worktree: string): string {
  return (
    `The project at ${projectPath} isn't indexed with codegraph yet: it is a git worktree (${worktree}) ` +
    'with no index of its own, and codegraph could not copy one in from another worktree of its ' +
    'repository (none has a complete index yet, or the copy failed), so codegraph cannot query it ' +
    'now. Use your built-in tools (Read/Grep/Glob) for that codebase ' +
    'meanwhile. The next codegraph call here tries the copy again: it succeeds once another ' +
    'worktree of this repository has a complete index, or once whatever held up this copy is done. ' +
    "Indexing is the user's decision — they can run 'codegraph init' in a " +
    'worktree of this repository to enable it.'
  );
}

/** The building root `projectPath` is in, as passed to `startColdBuild`; null when none. */
function buildingRootFor(projectPath: string): string | null {
  if (builds.size === 0) return null;
  const p = canonicalProjectRoot(projectPath);
  for (const [key, root] of builds) if (isAtOrBelow(p, key)) return root;
  return null;
}

/**
 * The compiled child entry. Beside this file in a build; when the server runs
 * from src/ (the test suite), the copy `npm run build` put in dist/.
 */
function coldBuildEntry(): string | null {
  const sibling = path.join(__dirname, 'cold-build.js');
  if (fs.existsSync(sibling)) return sibling;
  const built = path.resolve(__dirname, '../../../../dist/extensions/host/worktree-lifecycle/cold-build.js');
  return fs.existsSync(built) ? built : null;
}

/**
 * Start the detached cold build of `root`, the pattern of the daemon's own
 * spawn (`spawnDetachedDaemon`): its own process group, no stdio, unref'd, so
 * it finishes even if this server exits first. False when it cannot start.
 */
function startColdBuild(root: string): boolean {
  const entry = coldBuildEntry();
  if (!entry) return false;
  const key = canonicalProjectRoot(root);
  try {
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS, entry, root], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    builds.set(key, root);
    const settle = (failed: boolean) => {
      if (builds.get(key) !== root) return;
      builds.delete(key);
      if (failed) failedBuilds.add(key);
    };
    // `code` is null when a signal ended the child: killed, not failed.
    child.on('exit', (code) => settle(code !== null && code !== 0));
    child.on('error', () => settle(true)); // no executable: an async 'error', never a crash
    child.unref();
    return true;
  } catch {
    builds.delete(key);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** One seed or build decision per worktree at a time; concurrent calls share it. */
const inflight = new Map<string, Promise<SeedOutcome>>();

/**
 * Make sure the git worktree `projectPath` is in has an index of its own when
 * it should get one (see "When it runs" in the file comment): seed it from a
 * sibling, start a cold build, or leave it alone. Deduped per worktree root. Never
 * throws; a failure is logged to stderr and answers `none`, which leaves the
 * caller's existing guidance in place.
 */
export async function ensureWorktreeIndex(projectPath: string): Promise<SeedOutcome> {
  if (seedingDisabled()) return NONE;
  const building = buildingRootFor(projectPath);
  if (building) return { kind: 'building', root: building };
  try {
    // Everything up to the git lookup is synchronous stats, so the common
    // cases (an index of the tree's own, no git repository) cost no spawn.
    let nearest = findNearestCodeGraphRoot(projectPath);
    // A killed build's index of the tree's own counts as none: resolve past
    // it, and let the seed or build below replace it.
    let abandoned: string | null = null;
    if (nearest && isAbandonedIndex(nearest)) {
      abandoned = nearest;
      const up = path.dirname(nearest);
      nearest = up === nearest ? null : findNearestCodeGraphRoot(up);
    }
    if (!gitWorktreeRootMayBeBelow(projectPath, nearest)) return NONE;
    // A sensitive path is refused by the caller's own validation; never seed it.
    if (fs.existsSync(projectPath) && validateProjectPath(projectPath)) return NONE;
    const worktree = await worktreeRootOf(projectPath);
    if (!worktree) return NONE;
    // The abandoned index must be W's own; any other is left as it is.
    if (abandoned && !sameRoot(abandoned, worktree)) return NONE;
    if (nearest && isAtOrBelow(canonicalProjectRoot(nearest), canonicalProjectRoot(worktree))) return NONE;

    const key = canonicalProjectRoot(worktree);
    let pending = inflight.get(key);
    if (!pending) {
      pending = seedOrBuild(worktree, nearest, abandoned !== null).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return await pending;
  } catch (err) {
    process.stderr.write(
      `[CodeGraph MCP] Could not prepare an index for ${projectPath}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return NONE;
  }
}

/**
 * Seed W, or start its cold build, or neither. `replaceAbandoned`: W holds an
 * index a killed build left behind ({@link isAbandonedIndex}); it is
 * discarded only right before a seed or a build replaces it, so a worktree
 * that gets neither keeps what it had.
 */
async function seedOrBuild(worktree: string, nearest: string | null, replaceAbandoned: boolean): Promise<SeedOutcome> {
  if (validateProjectPath(worktree)) return NONE;
  const entries = await listGitWorktrees(worktree);
  if (!entries) return NONE;
  // An index above W that is not one of its repository's worktrees is a plain
  // ancestor directory's or another repository's (W is a submodule or an
  // embedded clone it covers): not a case this module seeds or builds.
  if (nearest && !entries.some((e) => sameRoot(e.path, nearest))) return NONE;
  // Another process (or an earlier call) may have given W its index meanwhile.
  if (!replaceAbandoned && isInitialized(worktree)) return NONE;
  // With the abandoned index kept, the call answers from it: no not-indexed text.
  const considered: SeedOutcome = replaceAbandoned ? NONE : { kind: 'none', worktree };

  const commonDir = await gitCommonDirAsync(worktree);
  const source = await pickFromEntries(worktree, entries);
  if (source) {
    // A live process took W's locks meanwhile: its index is not abandoned.
    if (replaceAbandoned && !discardAbandonedIndex(worktree)) return NONE;
    try {
      const { method, nonce } = await seedFromSibling(worktree, source);
      registerProject(worktree, { seeded: true, commonDir, seedNonce: nonce });
      process.stderr.write(`[CodeGraph MCP] Seeded the index of ${worktree} from ${source} (${method}).\n`);
      return { kind: 'seeded', root: worktree, source, method };
    } catch (err) {
      if (err instanceof SeedTargetTakenError || isInitialized(worktree)) return NONE;
      process.stderr.write(
        `[CodeGraph MCP] Could not seed ${worktree} from ${source}: ${err instanceof Error ? err.message : String(err)}\n`
      );
      // A sibling qualifies, so W's index is a copy, never a cold build: a
      // copy that failed (W's index locked by another process past the
      // retries, the copy itself failing) answers the not-indexed guidance,
      // and the next call tries the copy again. W has no index now (an
      // abandoned one was discarded above), so the worktree is named either way.
      return { kind: 'none', worktree };
    }
  }

  const key = canonicalProjectRoot(worktree);
  if (failedBuilds.has(key)) return considered;
  let registered = false;
  try {
    registered = commonDir !== null && hasRegisteredRepository(commonDir);
  } catch { /* an unreadable registry is no opt-in */ }
  if (!autoIndexOptedIn() && !registered) return considered;
  // The same refusal `codegraph init` applies (home directory, filesystem root).
  if (unsafeIndexRootReason(worktree)) return considered;
  // Someone else (`codegraph index`, another server's build) is already at it.
  if (isRebuildInProgress(worktree)) return { kind: 'building', root: worktree };
  if (replaceAbandoned && !discardAbandonedIndex(worktree)) return NONE;
  return startColdBuild(worktree) ? { kind: 'building', root: worktree } : considered;
}
