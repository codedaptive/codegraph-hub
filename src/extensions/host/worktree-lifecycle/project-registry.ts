/**
 * Global project registry: the roots CodeGraph manages beyond "an index the
 * user built by hand", under `<state dir>/projects/` (`CODEGRAPH_STATE_DIR`,
 * else `~/.codegraph`; see server/state-dir.ts).
 *
 * A root lands here in three ways. An index CodeGraph gave a git worktree on
 * its own (seeded from a sibling worktree or cold-built) is registered SEEDED,
 * with the repository's git common dir and the seed nonce written into that
 * index. `codegraph project pin <path>` registers it PINNED. `codegraph init
 * <dir> --no-git` registers a folder outside git NO_GIT: the opt-in that lets
 * codegraph index and answer for it (R-50; see server/optedInRootByStat.ts).
 * The registry is what lets the housekeeping sweep (`teardown.ts`) find
 * a seeded worktree after it is removed and reclaim its index. The MCP server
 * reads it for pins: its idle release never closes a pinned root, and the
 * machine server opens pinned roots at start and after each housekeeping pass,
 * seeding an unindexed worktree from an indexed sibling when possible (`pinned-open.ts`).
 *
 * The SEEDED bit says that CodeGraph once made an index at the ROOT; the seed
 * nonce says WHICH index. Each seed or cold build writes a fresh random nonce
 * into its database's `project_metadata` ({@link stampSeedNonce}) and records
 * the same nonce here. A database the user builds later at that path (another
 * repository cloned there, `codegraph init` after removing the index, a
 * `codegraph index` rebuild, which recreates the database) carries no nonce or
 * another one, so teardown, which deletes only a database holding the
 * recorded nonce ({@link readSeedNonce}), never deletes it. A nonce rather than
 * the file's inode: filesystems reuse inode numbers, and Windows reports none.
 *
 * Shape: one small JSON record per root, named by a hash of
 * {@link canonicalProjectRoot} so every spelling of a directory lands on one
 * record. Writes are atomic (temp file + rename), so a reader never sees a
 * half-written record. The registry is a source of truth (whether an index was
 * seeded, and which, decides whether teardown may delete it), so writes throw
 * rather than swallow errors; reads skip a record that does not parse.
 *
 * Every change to a record (register, pin, unpin, clearing the opt-in,
 * unregister, the sweep's settle) is one read-modify-write under that record's lock,
 * `<record>.json.lock`, so two processes changing one root (a pin from the CLI
 * while a server seeds it, a sweep tearing it down) never lose each other's
 * bit or nonce; see {@link withRecordLock}. Reads take no lock: the rename
 * makes each record whole.
 *
 * The record's booleans live in the `flags` bitmap, so a new flag needs no
 * change to the record's shape, and the date is ISO8601 text.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { canonicalProjectRoot, getCodeGraphDir } from '../../../directory';
import { loadNodeSqlite } from '../../../db/node-sqlite';
import { getStateDir } from '../server/state-dir';
import { createLockFile,removeLockIfUnchanged, snapshotLock, type LockSnapshot } from '../../../mcp/lock-takeover';

/**
 * Bitmap assignments for {@link RegisteredProject.flags}. Never reuse or
 * renumber a bit; records on disk carry these values.
 *
 *   bit 0  PINNED  never idle-released from the MCP project cache
 *   bit 1  SEEDED  CodeGraph made an index at this root on its own: copied in
 *                  from a sibling worktree, or cold-built by the index builder.
 *                  Teardown may delete the index once the worktree is gone,
 *                  and only the one whose seed nonce the record holds.
 *   bit 2  NO_GIT  a folder outside git a person opted in to indexing with
 *                  `codegraph init <dir> --no-git` (R-50); cleared by
 *                  `codegraph uninit` ({@link clearNonGitOptIn}) and by
 *                  removing the record.
 */
export const PROJECT_FLAG_PINNED = 1 << 0;
export const PROJECT_FLAG_SEEDED = 1 << 1;
export const PROJECT_FLAG_NO_GIT = 1 << 2;

export interface RegisteredProject {
  /** {@link canonicalProjectRoot} of the project. */
  root: string;
  /**
   * Realpath of the git common dir, recorded at registration; replaced by the
   * housekeeping sweep when the recorded one is missing but the root's own
   * `.git` leads to a repository that lists the root (teardown.ts). Null when
   * not recorded.
   */
  commonDir: string | null;
  /** Bitmap of `PROJECT_FLAG_*`. */
  flags: number;
  /** ISO8601 time of first registration. Re-registering keeps it. */
  registeredAt: string;
  /**
   * The nonce the last seed or cold build at this root wrote into its
   * database ({@link stampSeedNonce}). Absent when CodeGraph never made an
   * index here or the record carries none (a record without the field still
   * parses). Teardown then never deletes the index; it only unregisters the
   * root.
   */
  seedNonce?: string;
}

/** `<state dir>/projects`: machine-wide, shared by the server and every CLI command of one state dir. */
export function registryDir(): string {
  return path.join(getStateDir(), 'projects');
}

function recordPath(canonicalRoot: string): string {
  const hash = crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  return path.join(registryDir(), `${hash}.json`);
}

/**
 * A record without `seedNonce` is valid: an unseeded root, or a seeded record
 * that carries no nonce (teardown keeps that record's index).
 */
function isRecord(value: unknown): value is RegisteredProject {
  const v = value as Partial<RegisteredProject> | null;
  return !!v && typeof v.root === 'string' && typeof v.flags === 'number'
    && typeof v.registeredAt === 'string' && (v.commonDir === null || typeof v.commonDir === 'string')
    && (v.seedNonce === undefined || typeof v.seedNonce === 'string');
}

function readRecordFile(file: string): RegisteredProject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic write: a temp file in the same directory, then rename over the record. */
function writeRecord(rec: RegisteredProject): void {
  fs.mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  const file = recordPath(rec.root);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The record lock
// ---------------------------------------------------------------------------

/**
 * File age past which a record lock with no parseable pid may be taken over.
 * On filesystems without hard links, the lock is empty between its exclusive
 * create and its write; allow 10 s for that write before treating it as
 * abandoned. A lock naming another live process is never taken by age, even
 * when its timestamp is invalid or its pid has been reused by the OS.
 */
const RECORD_LOCK_STALE_MS = 10_000;

/**
 * How long a change waits for a record lock: about 30 s. A live holder can be
 * descheduled for seconds under load; teardown also holds the lock across a
 * git call bounded at 5 s (teardown.ts) and a recursive index deletion. Past
 * this deadline the change throws rather than wait indefinitely. This is a
 * time budget, not an attempt count: a lock released between a failed create
 * and the look that follows is tried again at once. The wait is synchronous
 * (Atomics.wait), blocking the builder's main thread when it calls here.
 */
const RECORD_LOCK_WAIT_MS = 30_000;

/**
 * Pauses between attempts on a held lock double from the first to the
 * longest: a lock freed after a short hold is taken within milliseconds, and
 * a long wait looks ten times a second.
 */
const RECORD_LOCK_FIRST_PAUSE_MS = 1;
const RECORD_LOCK_LONGEST_PAUSE_MS = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Signal-0 liveness; EPERM counts as alive (the process exists, it is not ours to signal). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the record lock `lockPath`, read as `snap`, may be taken over.
 * A parseable pid is judged independently of the timestamp: a dead pid or
 * this process's own pid is stale; another live pid is never stale by age.
 * Registry calls are synchronous and never nest, and only the builder's main
 * thread and the CLI change the registry, so our own pid means a leftover
 * from a failed release. Without a parseable pid, use the file's age against
 * {@link RECORD_LOCK_STALE_MS}, allowing the empty create-to-write interval
 * on filesystems without hard links.
 */
function isStaleRecordLock(lockPath: string, snap: LockSnapshot): boolean {
  const [pidLine = ''] = snap.raw.split('\n');
  const pid = Number(pidLine);
  if (!/^\d+$/.test(pidLine) || pid <= 0 || !Number.isSafeInteger(pid)) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > RECORD_LOCK_STALE_MS;
    } catch {
      return false; // gone or unreadable: the next create attempt decides
    }
  }
  return pid === process.pid || !isAlive(pid);
}

/**
 * Run `fn` holding `canonicalRoot`'s record lock: `<record>.json.lock`,
 * created exclusively ({@link createLockFile}: linked into place complete,
 * failing if any lock is there), stamped with the time of the create that
 * succeeds. A lock judged stale ({@link isStaleRecordLock}) is removed only
 * while it is still the very file judged, under its `.takeover` guard
 * ({@link removeLockIfUnchanged}), then the create is tried again; a lock gone
 * by the time it is looked at is tried again at once. Another live pid's lock
 * is never taken by age: wait synchronously with growing Atomics.wait pauses
 * until {@link RECORD_LOCK_WAIT_MS} has passed since the first attempt, then
 * throw if it is still held. In the builder this blocks the main thread. The
 * lock is removed afterwards only if it is still the one this call wrote.
 */
function withRecordLock<T>(canonicalRoot: string, fn: () => T): T {
  fs.mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  const lockPath = `${recordPath(canonicalRoot)}.lock`;
  const deadline = Date.now() + RECORD_LOCK_WAIT_MS;
  let pause = RECORD_LOCK_FIRST_PAUSE_MS;
  let body: string;
  for (;;) {
    body = `${process.pid}\n${new Date().toISOString()}`;
    if (createLockFile(lockPath, body, 0o600)) break;
    let snap: LockSnapshot | null = null;
    try { snap = snapshotLock(lockPath); } catch { /* unreadable: held */ }
    if (snap && isStaleRecordLock(lockPath, snap)) {
      try { removeLockIfUnchanged(lockPath, snap); } catch { /* left in place */ }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`The project registry record of ${canonicalRoot} is locked by another process (${lockPath})`);
    }
    // Removed or released meanwhile: try again at once.
    if (!fs.existsSync(lockPath)) continue;
    sleepSync(Math.min(pause, left));
    pause = Math.min(pause * 2, RECORD_LOCK_LONGEST_PAUSE_MS);
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === body) fs.unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}

/** A new record for `canonicalRoot`: no flags, no common dir, registered now. */
function newRecord(canonicalRoot: string): RegisteredProject {
  return { root: canonicalRoot, commonDir: null, flags: 0, registeredAt: new Date().toISOString() };
}

/**
 * Register `root`, or update its record. Idempotent, and never clears a set
 * bit: `seeded: false` on a seeded root leaves it seeded, and `noGit: false`
 * leaves an opted-in root opted in. A non-null
 * `commonDir` replaces a recorded one; omitted or null, the recorded one stays.
 * A non-empty `seedNonce` replaces a recorded one (each new seed or cold build
 * of the root brings its own); omitted, the recorded one stays, so pinning a
 * seeded root keeps its nonce. One read-modify-write under the record lock.
 */
export function registerProject(
  root: string,
  opts: { seeded?: boolean; noGit?: boolean; commonDir?: string | null; seedNonce?: string } = {},
): RegisteredProject {
  const canonical = canonicalProjectRoot(root);
  return withRecordLock(canonical, () => {
    const existing = readRecordFile(recordPath(canonical));
    const rec: RegisteredProject = existing ? { ...existing, root: canonical } : newRecord(canonical);
    if (opts.commonDir !== undefined && opts.commonDir !== null) rec.commonDir = opts.commonDir;
    if (opts.seeded) rec.flags |= PROJECT_FLAG_SEEDED;
    if (opts.noGit) rec.flags |= PROJECT_FLAG_NO_GIT;
    if (opts.seedNonce) rec.seedNonce = opts.seedNonce;
    writeRecord(rec);
    return rec;
  });
}

export function getRegisteredProject(root: string): RegisteredProject | null {
  const canonical = canonicalProjectRoot(root);
  const rec = readRecordFile(recordPath(canonical));
  return rec && rec.root === canonical ? rec : null;
}

/** Every registered project, ordered by root. Unreadable records are skipped. */
export function listRegisteredProjects(): RegisteredProject[] {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RegisteredProject[] = [];
  for (const f of files) {
    const rec = readRecordFile(path.join(registryDir(), f));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

/**
 * Set the pinned bit, registering `root` first when it is not registered.
 * Every other field, the seed nonce included, stays as recorded. One
 * read-modify-write under the record lock.
 */
export function pinProject(root: string): RegisteredProject {
  const canonical = canonicalProjectRoot(root);
  return withRecordLock(canonical, () => {
    const existing = readRecordFile(recordPath(canonical));
    const rec: RegisteredProject = existing ? { ...existing, root: canonical } : newRecord(canonical);
    if (!existing || existing.root !== canonical || (rec.flags & PROJECT_FLAG_PINNED) === 0) {
      rec.flags |= PROJECT_FLAG_PINNED;
      writeRecord(rec);
    }
    return rec;
  });
}

/**
 * Clear the pinned bit; null when `root` is not registered. Other bits stay.
 * One read-modify-write under the record lock.
 */
export function unpinProject(root: string): RegisteredProject | null {
  const canonical = canonicalProjectRoot(root);
  return withRecordLock(canonical, () => {
    const rec = readRecordFile(recordPath(canonical));
    if (!rec || rec.root !== canonical) return null;
    if ((rec.flags & PROJECT_FLAG_PINNED) !== 0) {
      rec.flags &= ~PROJECT_FLAG_PINNED;
      writeRecord(rec);
    }
    return rec;
  });
}

/**
 * Clear the opt-in bit (`codegraph uninit`). Other bits and the seed nonce stay; a record left with no
 * flags and no seed nonce records nothing, so it is removed and the answer is null. Null too when `root` is
 * not registered. One read-modify-write under the record lock.
 */
export function clearNonGitOptIn(root: string): RegisteredProject | null {
  const canonical = canonicalProjectRoot(root);
  return withRecordLock(canonical, () => {
    const file = recordPath(canonical);
    const rec = readRecordFile(file);
    if (!rec || rec.root !== canonical) return null;
    rec.flags &= ~PROJECT_FLAG_NO_GIT;
    if (rec.flags === 0 && rec.seedNonce === undefined) {
      removeRecordFile(file);
      return null;
    }
    writeRecord(rec);
    return rec;
  });
}

/** Remove the record file at `file`; false when there was none. */
function removeRecordFile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Drop `root`'s record, under the record lock. Deletes nothing else. False
 * when it was not registered.
 */
export function unregisterProject(root: string): boolean {
  const canonical = canonicalProjectRoot(root);
  return withRecordLock(canonical, () => removeRecordFile(recordPath(canonical)));
}

function sameRecord(a: RegisteredProject, b: RegisteredProject): boolean {
  return a.root === b.root && a.commonDir === b.commonDir && a.flags === b.flags
    && a.registeredAt === b.registeredAt && a.seedNonce === b.seedNonce;
}

/** What {@link settleProjectIfUnchanged} does with a record its `decide` saw unchanged. */
export type RecordSettlement =
  /** Drop the record. */
  | { action: 'remove' }
  /** Record `commonDir` as the root's git common dir; every other field stays. */
  | { action: 'update-common-dir'; commonDir: string }
  /** Leave the record as it is. */
  | { action: 'keep' };

/**
 * Settle `expected.root`'s record only while it is still exactly `expected`
 * (same flags, seed nonce, common dir and registration time), all under the
 * record lock. A record changed since `expected` was read (the root seeded
 * again, pinned, unpinned) is left as it now is: 'changed'; no record at all
 * is 'gone'. Otherwise `decide` runs under the same lock and its answer is
 * applied: 'removed', 'updated' (the new common dir written), or 'kept'.
 * Nothing registers the root again between `decide`'s work (teardown judges
 * the root once more and deletes its index there) and the removal. If
 * `decide` throws, the record stays and the error propagates.
 */
export function settleProjectIfUnchanged(
  expected: RegisteredProject,
  decide: () => RecordSettlement,
): 'removed' | 'updated' | 'kept' | 'changed' | 'gone' {
  const canonical = canonicalProjectRoot(expected.root);
  return withRecordLock(canonical, () => {
    const file = recordPath(canonical);
    const current = readRecordFile(file);
    if (!current) return fs.existsSync(file) ? 'changed' : 'gone';
    if (!sameRecord(current, expected)) return 'changed';
    const settlement = decide();
    if (settlement.action === 'keep') return 'kept';
    if (settlement.action === 'update-common-dir') {
      writeRecord({ ...current, commonDir: settlement.commonDir });
      return 'updated';
    }
    return removeRecordFile(file) ? 'removed' : 'gone';
  });
}

export function isPinned(root: string): boolean {
  const rec = getRegisteredProject(root);
  return !!rec && (rec.flags & PROJECT_FLAG_PINNED) !== 0;
}

// ---------------------------------------------------------------------------
// Seed nonce: which index at a root CodeGraph made
// ---------------------------------------------------------------------------

/** The `project_metadata` key the seed nonce is stored under. */
export const SEED_NONCE_KEY = 'seed_nonce';

/**
 * Write a fresh random nonce into the `project_metadata` of the index
 * database `dbFile` and return it. A seed calls it on its staged copy before
 * the copy is linked into place, and a cold build on the database it just
 * built before releasing `rebuild.pid`, so no reader ever sees that database
 * without it. A nonce already there (a seed copies its source's, if the source
 * was itself seeded) is replaced. Uses its own connection, with the upsert
 * CodeGraph uses for every metadata key. The TRUNCATE checkpoint moves the
 * row from the WAL into the main file, the one file a seed links into place;
 * should another connection hold it off (only the cold build has one open),
 * the row stays committed in the WAL until that connection checkpoints it.
 * Throws when the file is missing or the write fails.
 */
export function stampSeedNonce(dbFile: string): string {
  // DatabaseSync would create a missing file as an empty database.
  if (!fs.existsSync(dbFile)) throw new Error(`${dbFile} does not exist`);
  const nonce = crypto.randomBytes(16).toString('hex');
  const db = new (loadNodeSqlite().DatabaseSync)(dbFile);
  try {
    // The cold build's own connection is open but idle; this rides out a
    // commit of anything else that holds the write lock.
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(SEED_NONCE_KEY, nonce, Date.now());
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {
    db.close();
  }
  return nonce;
}

/**
 * The seed nonce in the database at `root`'s `.codegraph/codegraph.db`, read
 * read-only; null when there is no database, it holds no nonce, or it cannot
 * be read (an unreadable database never proves it is the seeded one).
 */
export function readSeedNonce(root: string): string | null {
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!fs.existsSync(dbFile)) return null;
  let db: { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void } | null = null;
  try {
    db = new (loadNodeSqlite().DatabaseSync)(dbFile, { readOnly: true });
    const row = db!.prepare('SELECT value FROM project_metadata WHERE key = ?').get(SEED_NONCE_KEY) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' && row.value !== '' ? row.value : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
