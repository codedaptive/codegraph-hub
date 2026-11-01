/**
 * Worktree seeding and cold builds: give a git worktree its own index on the
 * first MCP tool call that names it, instead of telling the agent the project
 * is not indexed (or silently serving the parent checkout's index, #155). A
 * directory outside git with no index gets a cold build too (see "Plain
 * directory" below).
 * This runs in the index builder (src/extensions/host/builder/), the process
 * that writes the indexes the server serves; the server only asks it (`BuilderClient.ensure`).
 *
 * The builder calls {@link ensureWorktreeIndex} for its `ensure` request, with
 * a {@link SeedHost} that runs the copy and the cold build as jobs on its
 * queue. Nothing here touches the agent's code: the only writes are a new
 * `.codegraph/` in the worktree and a record in the project registry.
 *
 * When it runs: `projectPath` is inside git worktree W and the index it
 * resolves to (`selectOwnIndexRoot`, ../server/index-root.ts) is not W's own,
 * i.e. there is none, or it is another worktree of the SAME repository (the
 * borrowed-index case). An index of W's own changes nothing: a stat walk from
 * `projectPath` up to the index finds no `.git` below it, so no git runs at
 * all; past that walk, the own-root check (`selectOwnIndexRoot`: git, a nested
 * answer remembered) and the toplevel lookup (one memoized
 * `git rev-parse --show-toplevel`) run. A sub-project's index nested inside W is not
 * W's own: `selectIndexRoot` resolves past it. An index above W is not W's
 * own either when W is a git repository nested below that index's root (an
 * embedded clone, a gitignored checkout, a submodule: its own worktree root,
 * with its own git common dir): it belongs to another repository, so
 * `selectOwnIndexRoot` does not select it, and W is seeded from its own
 * sibling worktrees or cold-built at W, whatever is indexed above it. That
 * holds when the index above covers W too (an embedded clone that is not
 * gitignored, a submodule): W still gets its own index and is not answered
 * from the outer one.
 *
 * Plain directory: `projectPath` has no `.git` entry at or above it and no
 * index at or above it either ({@link ensurePlainDirectoryIndex}). Its build
 * root is the calling session's anchor root (`anchorRoot`: the launch directory,
 * or its git worktree root) when the call carries one, else `projectPath`
 * itself, so a call on a subdirectory builds the launch directory once and
 * never an index of its own. There is nothing to seed from (no sibling
 * worktrees), so it is always a cold build, registered with no git common dir.
 * The anchor arrives over IPC and is data: it is built only when it contains
 * `projectPath`, is an existing directory that is not a sensitive folder, and
 * passes the same unsafe-root refusal `codegraph init` applies (home, a
 * filesystem root, a parent of home). A root refused for that reason or as a
 * sensitive folder (a session launched in `/tmp`), or one whose build failed,
 * answers {@link unbuiltDirectoryNote}, never the worktree text. Every
 * decision is made on `projectPath`'s realpath, and a queued cold build, plain
 * or worktree, is admitted again when its job starts ({@link admitColdBuild}):
 * it builds only while its root still names the directory it was approved on.
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
 *     (project-registry.ts). The builder's catch-up sync then re-indexes only
 *     the files that differ (rows store project-relative paths, so the copied
 *     rows are valid in W).
 *     A seed that fails while a sibling qualifies (W's index locked by
 *     another process past the retries, the copy failing) never falls back to
 *     a cold build: the call answers the not-indexed guidance, and the next
 *     call tries the seed again.
 *   - cold build: no sibling to copy (or no git at all, for a plain
 *     directory). The build is queued on the builder
 *     ({@link SeedHost.queueColdBuild}; ./cold-build.ts runs it), with no
 *     opt-in and no earlier registration: a worktree nobody has indexed gets
 *     an index of its own the first time a call names it. The build holds
 *     `rebuild.pid` for the whole init + index, and calls for W answer
 *     {@link buildingNote} meanwhile. It registers W SEEDED, with the nonce it
 *     wrote into the built index, once built, so teardown can reclaim it. A
 *     build the builder's death killed is not a failed build: the next call
 *     queues another.
 *
 * An index of a git worktree W's own that a killed build left behind
 * (`index_state` read and found other than 'complete', a `rebuild.pid` whose
 * holder is dead, no live writer) counts as no index: when a seed or a cold
 * build can replace it, its `.codegraph/` contents are discarded first, under
 * W's `rebuild.pid` and `codegraph.lock`. One whose state cannot be read is
 * kept as it is. A plain directory's killed build is not judged abandoned (a
 * `.git` entry is required, {@link isAbandonedIndex}): its database is
 * reopened and reconciled by the builder's catch-up, and reads may be
 * answered from it before that ends.
 * A seeder killed mid-copy leaves `codegraph.db.seed-<pid>-<hex>.tmp`; the
 * next seed of W removes each one whose pid is dead.
 *
 * `CODEGRAPH_NO_AUTO_SEED=1` turns all of it off, seed and cold build.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { execFile } from 'child_process';
import {
  canonicalProjectRoot,
  createDirectory,
  getCodeGraphDir,
  isInitialized,
  unsafeIndexRootReason,
} from '../../../directory';
import { FileLock, validateProjectPath } from '../../../utils';
import { loadNodeSqlite, type NodeSqliteModule } from '../../../db/node-sqlite';
import { gitRootByStat, ownIndexRootFor, realLocation, selectIndexRoot, selectOwnIndexRoot } from '../server/index-root';
import {
  canonicalGitPath,
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
import { registerProject, stampSeedNonce } from './project-registry';

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
  // than the plain not-indexed answer, which says nothing about a later call.
  // `unbuilt` is set instead when projectPath is a
  // plain directory (no git) whose build root this module refused or could
  // not build: `unsafe` is what the root looks like (`unsafeIndexRootReason`),
  // absent when its build failed; the answer is {@link unbuiltDirectoryNote}.
  | { kind: 'none'; worktree?: string; unbuilt?: { root: string; unsafe?: string } };

const NONE: SeedOutcome = { kind: 'none' };

/** The kill switch. Read per call, so a test or an operator can flip it live. */
function seedingDisabled(): boolean {
  return process.env.CODEGRAPH_NO_AUTO_SEED === '1';
}

// ---------------------------------------------------------------------------
// Worktree lookup (one memoized toplevel lookup per path)
// ---------------------------------------------------------------------------

/**
 * `git rev-parse --show-toplevel` per start directory. Keyed by the resolved
 * path, and remembered only when that path exists and git named a toplevel. A
 * null answer is never kept: it cannot tell "not in a working tree" from "git
 * could not run" (not installed, a failed spawn, a timeout), and remembering the
 * second would answer none for the path until the builder restarts, so the next
 * call asks again (one more `git rev-parse` per such call). A toplevel is kept
 * until the memo is cleared. Bounded: a long-lived builder process queried with many paths drops
 * the whole memo and starts over rather than grow; 512 is ample because only
 * paths that pass the stat check in {@link ensureWorktreeIndex} (a `.git` entry
 * between the path and the index it selected, or no index) reach this lookup,
 * and a clear costs one more `git rev-parse` per path. (The server's own gate
 * before it asks the builder, `worktreeSeedMayApply`, is a stat walk too, but
 * the index it selects may cost a git check: `selectOwnIndexRoot`.)
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
    // only answers about an existing path. Concurrent calls share the pending
    // lookup; once it settles without a toplevel the entry is dropped.
    if (fs.existsSync(key)) {
      const pending = hit;
      toplevelMemo.set(key, pending);
      const forget = (): void => { if (toplevelMemo.get(key) === pending) toplevelMemo.delete(key); };
      pending.then((root) => { if (root === null) forget(); }, forget);
    }
  }
  return hit;
}

/** `child` is `parent` or below it (both canonical). */
export function isAtOrBelow(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sameRoot(a: string, b: string): boolean {
  return a === b || canonicalProjectRoot(a) === canonicalProjectRoot(b);
}

/**
 * Whether a rebuild keeps `root` off limits to readers and seeders: the question the source choice, the
 * abandoned-index checks and the build decisions ask. By default another live process holds `rebuild.pid`
 * (`isRebuildInProgress`); the builder's host answers it with its own fences added ({@link SeedHost.rebuildHeld}),
 * because a rebuild it fenced holds `rebuild.pid` under the builder's own pid, which that default does not count.
 */
export type RebuildHeld = (root: string) => boolean;

/** The host's answer to {@link RebuildHeld}, or the default when the host has none. */
function rebuildHeldBy(host: SeedHost): RebuildHeld {
  return (root) => (host.rebuildHeld ? host.rebuildHeld(root) : isRebuildInProgress(root));
}

// ---------------------------------------------------------------------------
// Source choice
// ---------------------------------------------------------------------------

/**
 * Whether `root` holds a database whose index finished (`index_state` is
 * 'complete') and is not being rebuilt (`rebuildHeld`: {@link RebuildHeld}). A
 * database that cannot be read is not a source. One read-only open and a
 * primary-key lookup.
 */
function hasCompleteIndex(root: string, rebuildHeld: RebuildHeld): boolean {
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!fs.existsSync(dbFile)) return false;
  if (rebuildHeld(root)) return false;
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
 * `rebuild.pid` whose holder is dead (not held per `rebuildHeld`, which
 * defaults to `isRebuildInProgress`'s view, and not this process), no live `writer.pid` holder, and an
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
export function isAbandonedIndex(root: string, rebuildHeld: RebuildHeld = isRebuildInProgress): boolean {
  const dir = getCodeGraphDir(root);
  if (!fs.existsSync(path.join(dir, 'rebuild.pid'))) return false;
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const rebuild = readWriterLock(root, 'rebuild.pid');
  if (rebuild?.pid === process.pid || rebuildHeld(root)) return false;
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
 * process holds either lock, a rebuild holds the root (`rebuildHeld`: a fence of
 * this builder would be released by this function's own release of
 * `rebuild.pid`, which names the same pid) or the index turned out not to be
 * abandoned.
 */
function discardAbandonedIndex(root: string, rebuildHeld: RebuildHeld): boolean {
  const dir = getCodeGraphDir(root);
  if (!fs.existsSync(path.join(dir, 'codegraph.db'))) return true;
  if (rebuildHeld(root)) return false;
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

async function pickFromEntries(worktreeRoot: string, entries: GitWorktreeEntry[], rebuildHeld: RebuildHeld): Promise<string | null> {
  const self = entries.find((e) => sameRoot(e.path, worktreeRoot));
  const candidates = entries.filter((e) => !sameRoot(e.path, worktreeRoot) && hasCompleteIndex(e.path, rebuildHeld));
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
 * when no other worktree of its repository has a complete index that is not
 * being rebuilt (`rebuildHeld`, by default another live process's `rebuild.pid`).
 */
export async function pickSeedSource(worktreeRoot: string, rebuildHeld: RebuildHeld = isRebuildInProgress): Promise<string | null> {
  const root = (await gitWorktreeRootAsync(worktreeRoot)) ?? path.resolve(worktreeRoot);
  const entries = await listGitWorktrees(root);
  if (!entries) return null;
  return pickFromEntries(root, entries, rebuildHeld);
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

/** What a cold build was approved on; the host keeps it and gives it back to {@link admitColdBuild} when the job starts. */
export interface ColdBuildApproval {
  /** The root's realpath ({@link canonicalGitPath}) at approval: the job builds only while the root still resolves to it. */
  realRoot: string;
  /** A plain directory (no git at or above the root at approval): the job also requires that there still is none. */
  plain: boolean;
}

export type ColdBuildAdmission =
  | { ok: true; approval: ColdBuildApproval }
  // `git`: a plain directory's root has git at or above it now (the worktree rule's to build, never this one's).
  // `folder`: the root is a folder codegraph never builds (`reason` says which: unsafe index root, sensitive
  // folder, not an existing directory). `moved`: the root resolves to another directory than the approved one.
  | { ok: false; why: 'git' | 'folder' | 'moved'; reason: string };

/**
 * The one admission for a cold build, run when it is queued (`approved` absent) and again when its job
 * starts (`approved` is what the first run returned). A build writes `.codegraph/` into whatever its root
 * path names at that moment, and the root arrives from the IPC (a plain directory's anchor) or from git, so
 * the job must not trust what was true when it was queued: a path swapped for a link to another directory
 * while the job waited would otherwise be built there. The same checks both times, in this order: the root
 * still resolves to the approved realpath; for a plain directory, still no git at or above it; not an unsafe
 * index root (`unsafeIndexRootReason`: home, a filesystem root, a parent of home); not a sensitive folder,
 * and an existing directory (`validateProjectPath`). The last two read the root as spelled and as it resolves.
 *
 * The job runs this synchronously right before its build starts, but `CodeGraph.init` opens the root a moment
 * later (it awaits the grammar load first): a swap inside that window is not caught. It takes a writer on the
 * root's parent acting within that window of a job that waited minutes; closing it needs init to work on an
 * opened directory handle, which the engine does not offer.
 */
export function admitColdBuild(root: string, plain: boolean, approved?: ColdBuildApproval): ColdBuildAdmission {
  const realRoot = canonicalGitPath(root);
  if (approved && realRoot !== approved.realRoot) {
    return { ok: false, why: 'moved', reason: `${root} now resolves to ${realRoot}, not ${approved.realRoot} as when the build was approved` };
  }
  if (plain && gitRootByStat(realRoot) !== null) {
    return { ok: false, why: 'git', reason: `${root} is now inside a git repository` };
  }
  // Before the sensitive-folder check: a filesystem root is on that list too, and a session launched there
  // is owed the reason it is too broad, not the sensitive-folder text.
  const unsafe = unsafeIndexRootReason(root);
  if (unsafe) return { ok: false, why: 'folder', reason: unsafe };
  const refused = validateProjectPath(root);
  if (refused) return { ok: false, why: 'folder', reason: refused };
  return { ok: true, approval: { realRoot, plain } };
}

/**
 * What {@link ensureWorktreeIndex} needs from the process that owns the index
 * writes (the builder, src/extensions/host/builder/seed-host.ts): where its
 * queued work stands, and a way to queue more. The decision here stays
 * separate from the queue so the queue's priorities and its job log live in
 * one place.
 */
export interface SeedHost {
  /**
   * The root that is being built or seeded here (a cold build queued or
   * running, a seed queued or running) and that `projectPath` is at or below
   * and is its own root (`ownIndexRootFor`, ../server/index-root.ts): a root
   * above a git repository nested around `projectPath` is another repository's
   * build and is not named. Null when none. Calls for that root answer
   * {@link buildingNote}.
   */
  buildingRootFor(projectPath: string): string | null;
  /**
   * Whether the cold build of `root` failed in this process: not retried on
   * every call. A build killed with the builder is not recorded: it was
   * killed, not failed, and the next call builds again.
   */
  hasFailedBuild(root: string): boolean;
  /**
   * Whether a rebuild holds `root`: another live process's `rebuild.pid`, or (the builder's host) a fence it
   * gave a `codegraph index` that runs through it, whose `rebuild.pid` names the builder's own pid and so
   * is not another process's. A host without it answers by `rebuild.pid` of another live process alone.
   * A root a rebuild holds is neither a seed source, nor discarded, nor seeded or built over.
   */
  rebuildHeld?(root: string): boolean;
  /**
   * Queue the cold build of `root` (./cold-build.ts), unless one is already queued or running. `approval` is
   * what {@link admitColdBuild} approved: the job runs that admission again when it starts (the queue may
   * hold it for minutes, and `root` is a path, not a directory) and builds nothing unless it still holds.
   */
  queueColdBuild(root: string, approval: ColdBuildApproval): void;
  /**
   * Run `copy` (the seed of `root`, which reads the index of `source`) as a job on the queue. The job counts as
   * a job of `source` as well as of `root` while it is queued or running, and a host that fences roots for their
   * removal fails it when it starts if `source` or `root` is being removed, before `copy` opens anything.
   * `done: false` when it did not finish within the host's wait, because a long job was ahead of
   * it: the job stays queued, and {@link buildingRootFor} names `root` until
   * it ends. Rejects with the copy's error when it ran and failed.
   */
  runSeed<T>(root: string, source: string, copy: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }>;
}

/**
 * The answer a tool call for a root gets while its index is built. A
 * success-shaped note: never "not indexed" (it soon will be) and never an
 * empty result (nothing has been searched).
 */
export function buildingNote(root: string): string {
  return (
    `CodeGraph is building the index for ${root}. It is not ready yet; ` +
    'use your built-in tools (Read/Grep/Glob) for this codebase meanwhile, and ' +
    'retry codegraph here later; a large repository takes minutes to build.'
  );
}

/**
 * The not-indexed guidance for `projectPath`, inside git worktree `worktree`
 * (a linked worktree, or the main working tree of a repository nested in another
 * one's checkout: `projectPath` need not itself be a worktree root, so the note
 * says it is "in the git worktree", which holds for both),
 * when {@link ensureWorktreeIndex} could neither seed it nor build it: the
 * copy from a sibling failed, the build failed, or automatic indexing is off
 * (`CODEGRAPH_NO_AUTO_SEED=1` set in the environment turns it off).
 * A later call tries again where it can (it retries a failed copy), so the
 * plain "not indexed" guidance, which does not say a later call can succeed,
 * would be wrong there.
 */
export function unseededWorktreeNote(projectPath: string, worktree: string): string {
  return (
    `The project at ${projectPath} isn't indexed with codegraph yet: it is in the git worktree (${worktree}), ` +
    'which has no index of its own, and codegraph could not give it one (the copy from another worktree of its ' +
    'repository failed, the build failed, or automatic indexing is off (CODEGRAPH_NO_AUTO_SEED=1 is set; unset it ' +
    'to turn automatic indexing back on)), so codegraph cannot query it ' +
    'now. Use your built-in tools (Read/Grep/Glob) for that codebase ' +
    'meanwhile. The next codegraph call here tries again where it can: a failed copy is retried on the ' +
    'next call. ' +
    "If it keeps failing, the user can run 'codegraph init' in a " +
    'worktree of this repository to index it by hand.'
  );
}

/**
 * The answer for a plain directory (no git) whose build root `root` codegraph
 * will not build or could not build: `unsafe` is why codegraph refuses the root
 * ({@link admitColdBuild}: what it looks like, "your home directory", or the
 * sensitive-folder refusal), absent when its build failed (a failed build is
 * not retried until the CodeGraph server restarts: the memo lives in the
 * builder process). Success-shaped, like every expected condition, and it never tells
 * the agent to stop calling codegraph: a project inside the directory (a git
 * repository, or a directory the user ran `codegraph init` in) is served
 * when named, so the agent is pointed at one.
 */
export function unbuiltDirectoryNote(projectPath: string, root: string, unsafe?: string): string {
  const why = unsafe
    ? `codegraph does not build an index for ${root} (${unsafe}), which is too broad or too sensitive to index`
    : `the build of the index for ${root} failed, and codegraph will not retry it until the CodeGraph server restarts`;
  return (
    `The directory at ${projectPath} isn't indexed with codegraph, and ${why}. ` +
    'Use your built-in tools (Read/Grep/Glob) for code in it. ' +
    `A project inside ${root} is indexed when you name it: pass a projectPath that is a git repository ` +
    'inside it, or a directory the user has set up with \'codegraph init\'.'
  );
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** One seed or build decision per worktree at a time; concurrent calls share it. */
const inflight = new Map<string, Promise<SeedOutcome>>();

/**
 * Make sure the git worktree `projectPath` is in has an index of its own when
 * it should get one (see "When it runs" in the file comment): seed it from a
 * sibling, queue a cold build, or leave it alone. `none` without a worktree
 * says nothing needed doing: the caller serves the index `selectOwnIndexRoot`
 * names, if any. Deduped per worktree root. Never throws; a failure is logged
 * to stderr and answers `none`.
 *
 * A `projectPath` with no `.git` entry at or above it and no index at or
 * above it is a plain directory: it is cold-built at `anchorRoot` when the
 * caller has one (the session's launch directory; refused, with nothing built,
 * when it does not contain `projectPath`), else at `projectPath`
 * ({@link ensurePlainDirectoryIndex}). `anchorRoot` is never used for a path
 * in a git worktree, which keeps the worktree rules above.
 */
export async function ensureWorktreeIndex(projectPath: string, host: SeedHost, anchorRoot?: string): Promise<SeedOutcome> {
  if (seedingDisabled()) return NONE;
  const building = host.buildingRootFor(projectPath);
  if (building) return { kind: 'building', root: building };
  try {
    // The path as it really is: git's answer for a symlinked spelling is the real directory's (its repository,
    // not the lexical parents'), so every decision below, the plain-directory one and the build root included,
    // is made on that spelling, and two spellings of one directory get one answer. A symlink into a nested
    // repository from a plain anchor would otherwise read as plain and build the anchor.
    const target = canonicalGitPath(projectPath);
    // Up to the toplevel lookup this is synchronous: stats, plus the git check inside selectOwnIndexRoot for a
    // path with a `.git` entry below the index it finds (synchronous git spawns, a nested answer remembered).
    // The common cases (an index of the tree's own, no git repository) cost no spawn.
    // The index of the tree's own: one from above a git repository nested around `target` belongs to another
    // repository and is none here (selectOwnIndexRoot), so a nested clone is seeded or built for itself. So is
    // one git could not vouch for (git failing: the selection fails closed).
    let nearest = selectOwnIndexRoot(target);
    // A killed build's index of the tree's own counts as none: resolve past
    // it, and let the seed or build below replace it. The own-root test is on
    // `target`, not on `up`: an index above a nested repository that holds an
    // abandoned index of its own is another repository's, so it is none for `target`.
    let abandoned: string | null = null;
    if (nearest && isAbandonedIndex(nearest, rebuildHeldBy(host))) {
      abandoned = nearest;
      const up = path.dirname(nearest);
      nearest = ownIndexRootFor(target, up === nearest ? null : selectIndexRoot(up));
    }
    // No index to serve and no git repository around the path: a plain directory (a killed
    // build's abandoned index needs a `.git` at its root, so none is left unresolved here).
    if (nearest === null && gitRootByStat(target) === null) {
      return ensurePlainDirectoryIndex(target, anchorRoot, host);
    }
    // `target` keeps its lexical spelling where it does not exist yet, while `nearest` is spelled by the real
    // location: walk from the real one so the walk can reach `nearest`.
    if (!gitWorktreeRootMayBeBelow(realLocation(target), nearest)) return NONE;
    // A sensitive path is refused by the caller's own validation; never seed it.
    if (fs.existsSync(target) && validateProjectPath(target)) return NONE;
    const worktree = await worktreeRootOf(target);
    if (!worktree) return NONE;
    // The abandoned index must be W's own; any other is left as it is.
    if (abandoned && !sameRoot(abandoned, worktree)) return NONE;
    if (nearest && isAtOrBelow(canonicalProjectRoot(nearest), canonicalProjectRoot(worktree))) return NONE;

    const key = canonicalProjectRoot(worktree);
    let pending = inflight.get(key);
    if (!pending) {
      pending = seedOrBuild(worktree, nearest, abandoned !== null, host).finally(() => inflight.delete(key));
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
 * Queue the cold build of a plain directory's build root: `anchorRoot` when the
 * call has one, else `projectPath`. Both arguments are IPC data from the
 * server, so nothing is created before they pass: `projectPath` exists as a
 * directory and is not a sensitive folder; the anchor, when given, contains
 * `projectPath` (a root that does not contain the path asked about is not
 * what the call is about) and has no git repository at or above it; the root
 * is an existing directory that is not sensitive and not an unsafe index
 * root (`unsafeIndexRootReason`: home, a filesystem root, a parent of home),
 * both ({@link admitColdBuild}) answering `unbuilt` with why, so the caller
 * says why instead of the generic not-indexed text. A root whose build failed
 * in this builder answers `unbuilt` without a reason and is not rebuilt on
 * every call. A refused anchor answers `none` and builds nothing. `projectPath`
 * is the caller's realpath ({@link ensureWorktreeIndex}).
 */
function ensurePlainDirectoryIndex(projectPath: string, anchorRoot: string | undefined, host: SeedHost): SeedOutcome {
  // A sensitive folder is refused by the caller's own validation; never build for it. Also: the path must exist.
  if (validateProjectPath(projectPath)) return NONE;
  if (anchorRoot !== undefined && !isAtOrBelow(canonicalProjectRoot(projectPath), canonicalProjectRoot(anchorRoot))) return NONE;
  const root = canonicalGitPath(anchorRoot ?? projectPath);
  // The anchor contains the path and the path has no git around it, so no git at or above the root holds for an
  // honest anchor; the admission checks it anyway because a root inside a git repository is the worktree
  // rule's to build, never this one's.
  const admission = admitColdBuild(root, true);
  if (!admission.ok) {
    return admission.why === 'git' ? NONE : { kind: 'none', unbuilt: { root, unsafe: admission.reason } };
  }
  if (host.hasFailedBuild(root)) return { kind: 'none', unbuilt: { root } };
  // Another process (a `codegraph init`, an earlier builder) gave it an index meanwhile.
  if (isInitialized(root)) return NONE;
  // Someone else (`codegraph index`, another server's build) is already at it.
  if (rebuildHeldBy(host)(root)) return { kind: 'building', root };
  host.queueColdBuild(root, admission.approval);
  return { kind: 'building', root };
}

/**
 * Seed W, or queue its cold build, or neither. `replaceAbandoned`: W holds an
 * index a killed build left behind ({@link isAbandonedIndex}); it is
 * discarded only right before a seed or a build replaces it, so a worktree
 * that gets neither keeps what it had.
 */
async function seedOrBuild(
  worktree: string,
  nearest: string | null,
  replaceAbandoned: boolean,
  host: SeedHost,
): Promise<SeedOutcome> {
  if (validateProjectPath(worktree)) return NONE;
  const entries = await listGitWorktrees(worktree);
  if (!entries) return NONE;
  // The own-root selection above drops an index above a nested clone W, and one git could not vouch for, so an
  // index still above W is a sibling worktree's of W's repository. Anything else (a plain ancestor directory's
  // or another repository's) is not a case this module seeds or builds: a guard that should not fire.
  if (nearest && !entries.some((e) => sameRoot(e.path, nearest))) return NONE;
  // Another process (or an earlier call) may have given W its index meanwhile.
  if (!replaceAbandoned && isInitialized(worktree)) return NONE;
  // With the abandoned index kept, the call answers from it: no not-indexed text.
  const considered: SeedOutcome = replaceAbandoned ? NONE : { kind: 'none', worktree };

  const commonDir = await gitCommonDirAsync(worktree);
  const rebuildHeld = rebuildHeldBy(host);
  const source = await pickFromEntries(worktree, entries, rebuildHeld);
  if (source) {
    // A live process took W's locks meanwhile, or a rebuild holds W: its index is not abandoned.
    if (replaceAbandoned && !discardAbandonedIndex(worktree, rebuildHeld)) return NONE;
    try {
      // The copy is a job on the builder's queue; one that waits behind a long
      // job past the host's bound keeps its place, and the call answers 'building'.
      const run = await host.runSeed(worktree, source, async () => {
        const { method, nonce } = await seedFromSibling(worktree, source);
        registerProject(worktree, { seeded: true, commonDir, seedNonce: nonce });
        process.stderr.write(`[CodeGraph MCP] Seeded the index of ${worktree} from ${source} (${method}).\n`);
        return method;
      });
      if (!run.done) return { kind: 'building', root: worktree };
      return { kind: 'seeded', root: worktree, source, method: run.value };
    } catch (err) {
      if (err instanceof SeedTargetTakenError || isInitialized(worktree)) return NONE;
      process.stderr.write(
        `[CodeGraph MCP] Could not seed ${worktree} from ${source}: ${err instanceof Error ? err.message : String(err)}\n`
      );
      // A sibling qualifies, so W's index is a copy, never a cold build: a
      // copy that failed (W's index locked by another process past the
      // retries, the copy itself failing) answers the not-indexed guidance,
      // and the next call tries the copy again. W has no index now (an
      // abandoned one was discarded above), so the worktree is named either way. A seed refused because its
      // source (or W) is being removed by `codegraph uninit` ends here too: the caller reads the not-indexed
      // guidance and stderr says "the index of <root> is being removed".
      return { kind: 'none', worktree };
    }
  }

  // No sibling to copy: build W's index. There is no opt-in and no earlier
  // registration to ask for; a build that failed here is never retried until this builder restarts.
  if (host.hasFailedBuild(worktree)) return considered;
  // The same refusal `codegraph init` applies (home directory, filesystem root), and the admission the
  // build's job runs again when it starts.
  const admission = admitColdBuild(worktree, false);
  if (!admission.ok) return considered;
  // Someone else (`codegraph index`, another server's build) is already at it.
  if (rebuildHeld(worktree)) return { kind: 'building', root: worktree };
  if (replaceAbandoned && !discardAbandonedIndex(worktree, rebuildHeld)) return NONE;
  host.queueColdBuild(worktree, admission.approval);
  return { kind: 'building', root: worktree };
}
