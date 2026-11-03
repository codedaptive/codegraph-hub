/**
 * Project writer lock (#1740).
 *
 * At most one long-lived *writer* (a process that owns the project's
 * FileWatcher and sync) may serve a given project. The writer is the index
 * builder (`src/extensions/host/builder/`): every server of a state directory
 * has one builder, and the server itself never writes an index, so within one
 * state directory a project has one writer; this lock closes the gap between
 * processes: the builders of two state dirs (a development build beside the
 * live one), or of a server and a `CODEGRAPH_NO_DAEMON=1` session, would each
 * start a watcher, contend on `codegraph.lock`, and degrade auto-sync. The builder
 * takes it per held project, with mode `builder`; the cold build and the seed
 * take `rebuild.pid` with their own modes, and the lease a routed `codegraph index` holds takes
 * `rebuild.pid` and `writer.pid`, each with mode `rebuild`.
 *
 * Deliberately separate from `server.pid`: the server lock says which process
 * is the machine server of a state dir, and is proven by a socket hello; a
 * writer lock is per project and only about "who owns live auto-sync".
 *
 * Every record also carries a {@link LockStamp}: the writer's canonical
 * project root, the identity of the physical index it had open (the
 * `dev:ino` of the `.codegraph` directory and of `codegraph.db`), and the
 * writer's pid and OS start time (see the last paragraph). A copied
 * project carries its original's `.codegraph/` records with it, and their pids
 * are live (the original's server), so pid liveness alone would keep the copy
 * locked out forever. A record is FOREIGN ({@link isForeignLockRecord}) when
 * its recorded root is another project's AND neither recorded identity is this
 * project's index as it is now AND the recorded root's `.codegraph` is not
 * this project's index as it is now AND the recorded root's database is not
 * this project's database as it is now AND this project's database has one
 * hard link. A copy at another path (cp -R, rsync, clonefile: all make new
 * inodes, and a database with one link) has foreign records, and they are
 * treated like a dead holder: stale, cleared, retried, and invisible to
 * readers.
 *
 * No other copied or moved index makes its records foreign by this rule; pid
 * liveness and the start-time check below decide them, because the live holder
 * may still have that database open and calling it stale would start a second
 * writer on it:
 *   - a record at this same root, even with both inodes new: a `.codegraph/`
 *     moved aside and copied back to the same path (a restore) is followed by
 *     its live holder, which reopens the replaced database at that path;
 *   - a project moved with `mv` within one filesystem: a new root, but the
 *     same inodes;
 *   - a project whose `.codegraph` is a symlink to the recorded root's: both
 *     roots reach one index, so a restore of it, which the holder follows,
 *     leaves the record's inodes obsolete for both;
 *   - a project whose database is the same file as the recorded root's now,
 *     e.g. two `codegraph.db` symlinks to one external file: the holder
 *     follows the file, so a replacement of it leaves the record's inodes
 *     obsolete for both;
 *   - any record at a project whose `codegraph.db` has more than one hard
 *     link: the file is shared by definition, whatever the record's stamp
 *     says, because a holder that followed a database restored in place keeps
 *     the stamp of the one it first opened.
 * A move across filesystems copies: new inodes and a new root, so its records
 * are foreign there, which is safe: the old holder has only the old, now
 * unlinked files open, not the moved index.
 *
 * The stamp also names its writer: `pid` and `pidStart`, that process's OS
 * start time ({@link processStartTime}). A holder killed while it holds a lock
 * leaves its record behind, and once the OS gives its pid to an unrelated
 * process, pid liveness would call it held forever. So a record whose pid is
 * alive but started at another time than `pidStart` is treated as foreign
 * too, wherever it was written, this project's own root and a shared
 * (hard-linked) database included: stale, cleared, retried and invisible to
 * readers, like a dead holder's. A record written without `pidStart`
 * (Windows, where no start time is read; a lookup that failed when it was
 * written; a writer that did not record one), or whose
 * holder's start time cannot be read now, is decided by pid liveness alone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { canonicalProjectRoot, getCodeGraphDir, isSameIndexRoot, statInode } from '../directory';
import {
  createLockFile,
  removeLockIfUnchanged,
  snapshotLock,
  writeExclusiveTemp,
  type LockSnapshot,
} from './lock-takeover';
import { processStartTime } from './process-identity';
/** Signal-0 liveness (EPERM ⇒ alive). Local copy so the lock layer imports nothing from the server modules. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}


/**
 * Who wrote a lock record, stamped into every project lock: `writer.pid`,
 * `rebuild.pid` and `codegraph.lock`. The identities are
 * `dev:ino` strings read as bigints, in {@link statInode}'s form, so inodes
 * above 2^53 keep their precision.
 */
export interface LockStamp {
  /**
   * `canonicalProjectRoot` of the writer's project. Alone it decides nothing,
   * because a path can name a different index than the one the writer opened;
   * it limits the copied-index rule of {@link isForeignLockRecord}: a record at
   * the reader's own root is never a copied-in record, and neither is one
   * whose root's `.codegraph` or database is the reader's now. Such a record
   * is still foreign when its pid was reused (see `pidStart`).
   */
  root: string;
  /** Identity of the writer's `.codegraph` directory. Present together with `dbId`, or not at all. */
  dirId?: string;
  /** Identity of the writer's `codegraph.db`. Present together with `dirId`, or not at all. */
  dbId?: string;
  /**
   * The writing process's pid. The same as the record's own `pid` in the JSON
   * records; in `codegraph.lock` the stamp is the whole second line, so this
   * is the only pid that line carries. Absent in records written without it.
   */
  pid?: number;
  /**
   * The writing process's OS start time ({@link processStartTime}): ISO8601
   * UTC to the second on macOS and the BSDs, `linux:<boot_id>:<ticks>` on
   * Linux. Absent when it could not be read (always on Windows) and in
   * records written without it; such a record is never foreign by the
   * reused-pid rule, so pid liveness decides it unless the copied-index rule
   * of {@link isForeignLockRecord} applies.
   */
  pidStart?: string;
}

/**
 * Identity of the physical index at `projectRoot` as it is NOW: the `dev:ino`
 * of its data directory and of its database, and the database's hard-link
 * count. Null when either cannot be stat'd (no database yet, a stat error),
 * and always null on Windows, where {@link statInode} reports no usable inode
 * (`st_ino` there is not stable across every filesystem and handle); the
 * directory is read first, so the database is never stat'd there. The
 * database is read with ONE bigint stat, so its `dbId` (built in
 * {@link statInode}'s `dev:ino` form) and `dbLinks` describe the same file
 * even if it is replaced meanwhile. The database path is the one
 * `getDatabasePath` names, built here so the lock modules do not load the
 * SQLite layer.
 */
function readIndexIdentity(projectRoot: string): { dirId: string; dbId: string; dbLinks: bigint } | null {
  const dir = getCodeGraphDir(projectRoot);
  const dirId = statInode(dir);
  if (dirId === null) return null;
  try {
    const db = fs.statSync(path.join(dir, 'codegraph.db'), { bigint: true });
    return { dirId, dbId: `${db.dev}:${db.ino}`, dbLinks: db.nlink };
  } catch {
    return null;
  }
}

/**
 * The {@link LockStamp} for a record this process writes on `projectRoot`:
 * its canonical root, its index identity when that can be read, this
 * process's pid, and its start time when that can be read (kept once known).
 * A record written without an identity is never foreign by the copied-index
 * rule, and one without a start time never by the reused-pid rule; one
 * written without either is decided by pid liveness alone, as for a record of
 * the older format. The link count is read fresh by every reader and never
 * recorded.
 */
export function lockStamp(projectRoot: string): LockStamp {
  const identity = readIndexIdentity(projectRoot);
  const pidStart = processStartTime(process.pid);
  return {
    root: canonicalProjectRoot(projectRoot),
    ...(identity !== null ? { dirId: identity.dirId, dbId: identity.dbId } : {}),
    pid: process.pid,
    ...(pidStart !== null ? { pidStart } : {}),
  };
}

/**
 * Whether a record names a live pid that is no longer its writer: it carries
 * `pid` and `pidStart`, the pid is alive, and the OS now reports another start
 * time for it. A dead pid is not "reused" here (liveness already makes it
 * stale), and an unreadable start time is no evidence. A mismatch seen through
 * the start-time cache is re-read fresh before it counts, so a cached answer
 * from before a new holder took the pid can never steal that holder's lock.
 */
function isReusedPidRecord(record: Record<string, unknown>): boolean {
  const { pid, pidStart } = record;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  if (typeof pidStart !== 'string' || pidStart === '') return false;
  if (!isProcessAlive(pid)) return false;
  const now = processStartTime(pid);
  if (now === null || now === pidStart) return false;
  const fresh = processStartTime(pid, { fresh: true });
  return fresh !== null && fresh !== pidStart;
}

/**
 * Whether a lock record must be treated as no holder's: its pid was reused
 * by another process, or it was written for another project's physical index
 * (copied in with a `.codegraph/` from elsewhere). Either makes it stale even
 * though its pid is alive.
 *
 * The two rules are checked in that order, and either one alone is enough.
 *
 * Reused pid: true when the record carries `pid` and `pidStart`, that pid is
 * alive, and its current OS start time ({@link processStartTime}) differs from
 * `pidStart`. It is checked first and applies to every record, whatever its
 * root and whatever the database's link count: a record at this project's own
 * root, or on a shared (hard-linked) database, is foreign when its pid was
 * reused. A record without `pidStart`, or whose holder's start time cannot be
 * read now (Windows, a `ps` that failed or ran out, a hidden `/proc` entry),
 * is not reused by this rule.
 *
 * Copied index: checked only for a record whose pid was not found reused, and
 * true only when ALL of these hold:
 *
 *   - the recorded `root` is a non-empty string that differs from
 *     `canonicalProjectRoot(projectRoot)`, compared exactly as recorded (no
 *     trim, no normalisation of the recorded value);
 *   - the record carries both identities, `dirId` and `dbId`;
 *   - this project's identity can be read now (a database exists, the stats
 *     succeed, not Windows);
 *   - this project's `codegraph.db` has exactly one hard link;
 *   - neither identity matches it: the directory differs AND the database
 *     differs;
 *   - the recorded root's `.codegraph` is not this project's: it does not
 *     resolve to the same directory now ({@link isSameIndexRoot});
 *   - the recorded root's database is not this project's: its identity read
 *     now is absent or differs from this project's `dbId`.
 *
 * So a copy at another path, which has a new root, a new directory and a new
 * database with one link (cp -R, rsync and clonefile all write a new file), is
 * foreign. A record at this same root is never a copied-in record, even when
 * both inodes changed: a `.codegraph/` moved aside and copied back (a restore)
 * is followed by its live holder (`CodeGraph.reopenIfReplaced` opens the
 * replaced database at the same path), so calling that holder stale would
 * start a second writer on the database it now has open. The same holds for a
 * record whose root's `.codegraph` is this project's index now, such as a
 * project whose `.codegraph` is a symlink to that root's: that holder follows a
 * restore of the index too. So does a record whose root's database is this
 * project's database now, though their directories differ, such as two
 * `codegraph.db` symlinks to one external file: both projects reach one
 * database, which the holder follows when it is replaced. No record is a
 * copied-in one at a project whose database has more than one hard link: that
 * file is shared by definition, and another project's live holder may have it
 * open. A project moved within one filesystem (same inodes, new root) is not a
 * copy either. These exemptions are from the copied-index rule only; the
 * reused-pid rule above still applies to every one of those records. A record
 * that neither rule makes foreign, including one with no root, no identity
 * and no `pidStart` (older formats), is decided by pid liveness. `record` is
 * any parsed record; only its `root`, `dirId`, `dbId`, `pid` and `pidStart`
 * are read.
 *
 * Limits. A record's stamp describes the index its writer opened, and a writer
 * that later follows a database replaced in place keeps its original stamp
 * (the copied-index rule exempts same-root records, hardlinked databases and a
 * recorded root whose `.codegraph` or database is this project's now, which
 * covers that; the stamp's `pid` and `pidStart` stay true of that
 * writer, so the reused-pid rule is unaffected). A filesystem alias that
 * reports different `dev:ino` for one file (some FUSE or network mounts) is
 * outside what the stamp can see.
 */
export function isForeignLockRecord(record: unknown, projectRoot: string): boolean {
  if (record === null || typeof record !== 'object') return false;
  if (isReusedPidRecord(record as Record<string, unknown>)) return true;
  const { root, dirId, dbId } = record as Record<string, unknown>;
  if (typeof root !== 'string' || root === '' || root === canonicalProjectRoot(projectRoot)) return false;
  if (typeof dirId !== 'string' || dirId === '' || typeof dbId !== 'string' || dbId === '') return false;
  const current = readIndexIdentity(projectRoot);
  if (current === null) return false;
  // A database with a second name is shared, so the record is not a copied-in
  // one and pid liveness decides it; a reused pid was already caught above.
  if (current.dbLinks > 1n) return false;
  if (dirId === current.dirId || dbId === current.dbId) return false;
  // The recorded identities describe the index as the holder opened it, and a
  // restore (or a replaced database behind a link) changes them while the
  // holder follows the new files. When the recorded root's `.codegraph` is
  // this project's index now, the holder still has it open under that other
  // name. The same holds when the recorded root's database, read now, is this
  // project's database: both projects reach one file, whatever their
  // directories are.
  const recorded = readIndexIdentity(root);
  if (recorded !== null && recorded.dbId === current.dbId) return false;
  return !isSameIndexRoot(root, projectRoot);
}

/** Absolute path to the writer pid lockfile for `projectRoot`. */
export function getWriterPidPath(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): string {
  let root = projectRoot;
  try { root = fs.realpathSync(projectRoot); } catch { /* keep lexical */ }
  return path.join(getCodeGraphDir(root), lockName);
}

/**
 * Structured contents of the writer pidfile. The stamp fields are absent in
 * older-format records; pid liveness alone decides those.
 */
export interface WriterLockInfo extends Partial<LockStamp> {
  pid: number;
  /** Who took the slot (`builder`: the index builder's hold on a project; `cold-build`, `seed`: the builder's index jobs; `rebuild`: `codegraph index`) — for actionable error text only. */
  mode: string;
  startedAt: number;
  /** False until the MCP owner has finished its initial catch-up. */
  ready?: boolean;
}

export type WriterAcquireResult =
  | { kind: 'acquired'; pidPath: string; info: WriterLockInfo }
  | { kind: 'taken'; existing: WriterLockInfo | null; pidPath: string };

function encode(info: WriterLockInfo): string {
  return JSON.stringify(info) + '\n';
}

/**
 * Parse a writer record. Passes the stamp fields (`root`, `dirId`, `dbId`,
 * `pidStart`) through when they are strings, so a record rewritten from its
 * decode ({@link markWriterReady}) keeps them. With `projectRoot`, a record foreign to that project
 * ({@link isForeignLockRecord}: its pid reused, or another project's) decodes
 * as null, exactly like an unreadable record, so callers see no holder.
 */
export function decodeWriterLockInfo(raw: string, projectRoot?: string): WriterLockInfo | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<WriterLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.mode !== 'string') return null;
    if (projectRoot !== undefined && isForeignLockRecord(parsed, projectRoot)) return null;
    return {
      pid: parsed.pid,
      mode: parsed.mode,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      ...(typeof parsed.ready === 'boolean' ? { ready: parsed.ready } : {}),
      ...(typeof parsed.root === 'string' ? { root: parsed.root } : {}),
      ...(typeof parsed.dirId === 'string' ? { dirId: parsed.dirId } : {}),
      ...(typeof parsed.dbId === 'string' ? { dbId: parsed.dbId } : {}),
      ...(typeof parsed.pidStart === 'string' ? { pidStart: parsed.pidStart } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically create `writer.pid` (or `rebuild.pid`) with {@link createLockFile}
 * (link-into-place, O_EXCL fallback). The record carries this project's
 * {@link lockStamp}. If the lock is held by a dead PID, is malformed, or holds
 * a foreign record (its pid now names a process that started at another time,
 * or it is another project's, copied in with its `.codegraph/`: see
 * {@link isForeignLockRecord}), it is stale: judged from one
 * {@link snapshotLock}, removed with {@link removeLockIfUnchanged} only if it is
 * still that very file (under the `.takeover` guard, so a competing taker's
 * fresh lock is not deleted; see the residuals in lock-takeover.ts). An
 * unreadable lock is left in place and reported taken. The create is then
 * tried once more whatever the removal found, busy included; it stays
 * exclusive and wins only if no lock is in place. Never steals from a live
 * holder whose record is not foreign: one whose recorded start time matches
 * its pid's (or that records none, or whose start time cannot be read now),
 * and that is not another project's copied-in record.
 */
export function tryAcquireWriterLock(
  projectRoot: string,
  mode: string,
  lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid',
): WriterAcquireResult {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const info: WriterLockInfo = {
    pid: process.pid,
    mode,
    startedAt: Date.now(),
    ready: false,
    ...lockStamp(projectRoot),
  };

  /** Try the exclusive create; on loss, the snapshot of whatever holds it (null if gone or unreadable). */
  const attempt = (): { result: WriterAcquireResult; snapshot: LockSnapshot | null } => {
    if (createLockFile(pidPath, encode(info), 0o600)) {
      return { result: { kind: 'acquired', pidPath, info }, snapshot: null };
    }
    let snapshot: LockSnapshot | null = null;
    let existing: WriterLockInfo | null = null;
    try {
      snapshot = snapshotLock(pidPath);
      // A foreign record (reused pid, or another project's) decodes as null,
      // so it is stale below like a dead one.
      if (snapshot) existing = decodeWriterLockInfo(snapshot.raw, projectRoot);
    } catch { /* unreadable */ }
    return { result: { kind: 'taken', existing, pidPath }, snapshot };
  };

  const first = attempt();
  const result = first.result;
  if (result.kind === 'taken' && result.existing && result.existing.pid === process.pid) {
    // Same process already holds it (re-acquiring its own slot).
    return { kind: 'acquired', pidPath: result.pidPath, info: result.existing };
  }
  if (result.kind === 'taken') {
    const existing = result.existing;
    if (!existing || existing.pid <= 0 || !isProcessAlive(existing.pid)) {
      // Stale (dead, malformed or foreign), judged from this one snapshot.
      // An unreadable lock gives no snapshot to compare, so it is not removed
      // here; the create below then reports it taken.
      if (first.snapshot) {
        try { removeLockIfUnchanged(pidPath, first.snapshot); } catch { /* left in place */ }
      }
      // Whatever the removal found (removed, gone, changed, busy), the create
      // stays exclusive: it wins only if no lock is in place.
      return attempt().result;
    }
  }
  return result;
}

/**
 * Publish catch-up readiness without exposing a partially-written pidfile:
 * the record goes to a private temp file ({@link writeExclusiveTemp}: a fresh
 * random name, created exclusively, so nothing planted beside the lock is
 * written through) and is renamed over. The rewritten record keeps the stamp
 * it was acquired with.
 */
export function markWriterReady(projectRoot: string): void {
  const pidPath = getWriterPidPath(projectRoot);
  const info = readWriterLock(projectRoot);
  if (!info || info.pid !== process.pid) return;
  const tmp = writeExclusiveTemp(pidPath, encode({ ...info, ready: true }), 0o600);
  try {
    fs.renameSync(tmp, pidPath);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed into place */ }
  }
}

/** Release if we still own the lock (pid match). */
export function releaseWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): void {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  try {
    if (!fs.existsSync(pidPath)) return;
    const info = decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'));
    if (info && info.pid === process.pid) {
      fs.unlinkSync(pidPath);
    }
  } catch { /* best-effort */ }
}

/**
 * Read current lock without acquiring. A foreign record (its pid reused by
 * another process, or another project's copied in with its `.codegraph/`:
 * {@link isForeignLockRecord}) reads as null: no holder.
 */
export function readWriterLock(projectRoot: string, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): WriterLockInfo | null {
  const pidPath = getWriterPidPath(projectRoot, lockName);
  try {
    return decodeWriterLockInfo(fs.readFileSync(pidPath, 'utf8'), projectRoot);
  } catch {
    return null;
  }
}

/**
 * Actionable message when another live process owns the writer lock (#1740).
 * A dead holder's lock, and one whose pid now names a process that started
 * after the record was written, are reclaimed without anyone acting, so this
 * is reached for a live holder that is the record's writer, or for a record
 * that cannot be checked that far (no recorded start time, or none readable
 * now). Deleting the file is advised only if that process is not a CodeGraph
 * server.
 */
export function writerLockHeldMessage(
  existing: WriterLockInfo | null,
  pidPath: string,
): string {
  const who = existing && existing.pid > 0
    ? `PID ${existing.pid} (${existing.mode || 'unknown'} mode)`
    : 'another process';
  return (
    'CodeGraph writer lock held by ' + who + '. ' +
    'Only one live MCP writer may serve a project (auto-sync / index). ' +
    'Stop the other server (if it is the shared daemon, stop it with `codegraph daemon --stop`; otherwise end the other MCP session), ' +
    'or unset CODEGRAPH_NO_DAEMON so additional clients proxy to the shared daemon. ' +
    'If that process is not a CodeGraph server, delete ' + pidPath
  );
}

/**
 * An index rebuild (`codegraph index`) owns the database. Expected and brief,
 * so the MCP layer answers it as guidance, never as a tool error (#1325).
 */
export class RebuildInProgressError extends Error {
  constructor() {
    super('CodeGraph index rebuild is in progress; retry when it finishes.');
    this.name = 'RebuildInProgressError';
  }
}

export function assertNoRebuild(root: string): void {
  if (isRebuildInProgress(root)) throw new RebuildInProgressError();
}

/**
 * Whether another live process holds the project's rebuild lock (`codegraph
 * index`). Rebuild intent is separate from writer ownership: the rebuild takes
 * `rebuild.pid` BEFORE asking the server to release the project, so a tool call
 * arriving in the gap cannot reopen SQLite. A foreign `rebuild.pid` (another project's,
 * copied in with its `.codegraph/`) is not a rebuild of this one, and neither
 * is one whose pid now names a process that started at another time than the
 * record says (a rebuild killed, its pid since reused): that record reads as no
 * holder, so a killed rebuild does not block the next query wherever a start
 * time was recorded.
 */
export function isRebuildInProgress(root: string): boolean {
  const lock = readWriterLock(root, 'rebuild.pid');
  return !!lock && lock.pid !== process.pid && isProcessAlive(lock.pid);
}
