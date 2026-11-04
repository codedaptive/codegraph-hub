/**
 * Atomic stale-lock takeover for pid lock files (`writer.pid`, `rebuild.pid`,
 * `codegraph.lock`, and the state dir's `server.pid`).
 *
 * The race this closes: taker B reads a lock, judges it stale (dead pid,
 * foreign record), then unlinks it. Between B's judgement and B's unlink,
 * taker A removes the same stale lock and creates its own fresh one; B's
 * unlink then deletes A's FRESH lock and both go on to hold it. A re-read
 * before the unlink only narrows that window. Here every removal of a lock by
 * a non-owner happens under a guard file,
 * `${lockPath}.takeover`, created exclusively with {@link createLockFile} (linked
 * into place, O_EXCL fallback) with this process's pid as its body, and only
 * after re-checking that the lock is still the very file the caller judged.
 * Two takers cannot interleave between compare and unlink, apart from the
 * residuals noted at `clearDeadGuard` and {@link createLockFile}, and the
 * same-bytes residual under "Unchanged" below.
 *
 * How a caller uses it:
 *   1. {@link snapshotLock} the lock once and judge staleness from
 *      `snapshot.raw` alone (pid liveness, foreign-record rules: all the
 *      caller's own policy). Never re-read the file to judge.
 *   2. Hand the snapshot it judged stale to {@link removeLockIfUnchanged}.
 *   3. Whatever the result, re-attempt its own acquire ({@link createLockFile}
 *      or its equivalent), which stays exclusive: it fails if anyone else's
 *      lock is in place.
 *
 * Results:
 *   - 'removed': the judged file was still in place and this call removed it.
 *   - 'gone': the lock no longer exists (someone else removed it).
 *   - 'changed': a different file is in place now (other bytes, or the same
 *     bytes in a new inode: a lock removed and re-created is a new lock), or
 *     it can no longer be read. Left untouched: it was never judged.
 *   - 'busy': the guard is held by another live process (mid-takeover), by
 *     this process in an enclosing takeover of the same lock, or on Windows
 *     is still delete-pending. Retried for about 200 ms first (not in the
 *     enclosing-takeover case, which is busy at once). Nothing was touched;
 *     the caller's exclusive create, or its false return, decides.
 *
 * "Unchanged" means the same bytes AND, off Windows, the same inode and
 * device. Windows has no stable inode through `fs.stat` on every filesystem,
 * so there the compare is content only.
 *
 * Accepted residual (same bytes, ABA): the compare cannot tell the judged
 * lock from a newer one with identical bytes (off Windows, also in the same
 * inode on the same device). If, between a taker's judgement and its compare,
 * another taker replaces the stale lock with a fresh one whose bytes match,
 * the compare passes and the fresh lock is removed. Identical bytes need the
 * new holder to have the dead holder's pid, so it needs pid reuse inside that
 * window. For a bare-pid `codegraph.lock` (FileLock without an owner) pid
 * reuse is all it needs. Every stamped record (`writer.pid`, `rebuild.pid`,
 * and `codegraph.lock` with an owner) also carries its writer's
 * OS start time, `pidStart`, where one can be read, so the new holder must
 * also have started in the same second (macOS) or clock tick (Linux) as the
 * dead one; and `writer.pid`, `rebuild.pid` and `server.pid` carry their
 * `startedAt` millisecond, which must match too. Off Windows the fresh file
 * must also land in the judged file's freed inode; on Windows no start time
 * is recorded and the bytes are all that is compared, so a `codegraph.lock`
 * there (its stamp the same for any holder with that pid at that root) is
 * where this residual is widest.
 *
 * Imports Node builtins only because `src/utils.ts` (FileLock) imports this
 * module: importing `directory` here would close the cycle
 * `directory` → `sync/watch-policy` → `utils` → this module → `directory`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

/** One read of a lock file: its bytes and (off Windows) the identity of the file they came from. */
export interface LockSnapshot {
  raw: string;
  /** Inode number; null on Windows. */
  ino: bigint | null;
  /** Device number; null on Windows. */
  dev: bigint | null;
}

/**
 * Bounded waits while another process holds the guard: 2+5+10+25+50+100 = 192 ms
 * in total. A guard is held only for a compare and an unlink, so this outlasts
 * a normal holder while bounding a synchronous wait.
 */
const BUSY_RETRY_DELAYS_MS = [2, 5, 10, 25, 50, 100];

/** Guards this process holds right now, so a nested takeover of the same lock is busy, not a stale own-pid guard. */
const heldGuards = new Set<string>();

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Signal-0 liveness; EPERM counts as alive (the process exists, it is just
 * not ours to signal). A local copy: this module imports builtins only.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM';
  }
}

/**
 * Read `lockPath` once, through one fd, so the bytes and the inode describe
 * the same file. Null when the lock does not exist (ENOENT); any other error
 * (a directory, no read permission) throws, and callers fail closed on it.
 */
export function snapshotLock(lockPath: string): LockSnapshot | null {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'r');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
  try {
    const raw = fs.readFileSync(fd, 'utf8');
    if (process.platform === 'win32') return { raw, ino: null, dev: null };
    const st = fs.fstatSync(fd, { bigint: true });
    return { raw, ino: st.ino, dev: st.dev };
  } finally {
    fs.closeSync(fd);
  }
}

function sameLock(cur: LockSnapshot, judged: LockSnapshot): boolean {
  if (cur.raw !== judged.raw) return false;
  if (process.platform === 'win32') return true;
  return cur.ino !== null && cur.ino === judged.ino && cur.dev === judged.dev;
}

/** Snapshot for a compare: an unreadable lock is treated as changed (`undefined`), never as gone. */
function snapshotForCompare(lockPath: string): LockSnapshot | null | undefined {
  try {
    return snapshotLock(lockPath);
  } catch {
    return undefined;
  }
}

/**
 * Fresh names tried by {@link writeExclusiveTemp} before it gives up. Each name
 * carries 48 random bits, so a second attempt is needed only when an entry is
 * already at the name drawn; eight in a row means something is wrong.
 */
const TEMP_NAME_ATTEMPTS = 8;

/**
 * Write `body` to a new private temp file beside `lockPath` and return its
 * path, `${lockPath}.${pid}.${12 random hex digits}.tmp`. The name is drawn
 * fresh on every call, so two calls never share one: not two processes, and
 * not two worker threads of one process (they share a pid). The file is opened
 * `wx` (O_CREAT|O_EXCL) with `mode` (0o666 when absent; the umask applies, as
 * for any create). O_EXCL refuses any existing entry, a symlink included, even
 * a dangling one, and never follows it, so nothing at the name can redirect
 * the write into, or truncate, another file. An existing entry is never
 * removed: it may be another call's temp file. On EEXIST a new name is drawn,
 * up to {@link TEMP_NAME_ATTEMPTS} names, and then the last EEXIST throws. Any
 * other open error throws at once. If the write fails, the file this call
 * created is removed and the error rethrown. On return the caller owns the
 * file and removes it.
 *
 * Every temp write on the pid lock files goes through here: {@link createLockFile}
 * (and so the `.takeover` guard), `markWriterReady`, `tryAcquireDaemonLock` and
 * `refreshDaemonLock`.
 */
export function writeExclusiveTemp(lockPath: string, body: string, mode?: number): string {
  let lastExists: unknown;
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt++) {
    const tmp = `${lockPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
      lastExists = err;
      continue;
    }
    try {
      fs.writeFileSync(fd, body);
    } catch (err) {
      fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
    fs.closeSync(fd);
    return tmp;
  }
  throw lastExists;
}

/**
 * Create `lockPath` with `body`, exclusively. The body goes to a private temp
 * file (created exclusively under a fresh random name by
 * {@link writeExclusiveTemp}, so nothing planted beside the lock is written
 * through or removed) that is hard-linked into place: link() is atomic and fails
 * with EEXIST if the target exists, so the lock appears in one step already
 * complete. Returns true when this call created it, false on EEXIST. Once
 * created, the temp file is removed on every path. Other errors throw,
 * including a temp file that cannot be created.
 *
 * Any link error other than EEXIST falls back to an O_EXCL create plus a write
 * through the same fd; that covers filesystems without hard links (ExFAT/FAT,
 * some network mounts: ENOTSUP, EPERM or EISDIR depending on the OS), and a
 * genuine error surfaces from the O_EXCL open instead. The fallback is still
 * exclusive, but a reader can see the lock empty or partly written for the
 * microseconds between create and write. A taker reading it in that window
 * judges it malformed and can remove it, so on those filesystems a fresh lock
 * is not protected. Filesystems with hard links have no such window.
 */
export function createLockFile(lockPath: string, body: string, mode?: number): boolean {
  const tmp = writeExclusiveTemp(lockPath, body, mode);
  try {
    try {
      fs.linkSync(tmp, lockPath);
      return true;
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
    }
    let fd: number;
    try {
      fd = mode === undefined ? fs.openSync(lockPath, 'wx') : fs.openSync(lockPath, 'wx', mode);
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
      throw err;
    }
    try {
      fs.writeSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already removed */ }
  }
}

/**
 * Create the guard. True = ours. False = held by another live process (or,
 * on Windows, still delete-pending from its last holder: EPERM/EACCES/EBUSY).
 */
function tryCreateGuard(guard: string): boolean {
  try {
    return createLockFile(guard, String(process.pid), 0o600);
  } catch (err) {
    const code = errCode(err) ?? '';
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(code)) return false;
    throw err;
  }
}

/**
 * A guard whose file was last written longer ago than this is stale, whatever
 * pid it names and whatever its body. A guard is held for one compare and one
 * unlink: microseconds. A guard left by a taker
 * killed inside it, whose pid the OS has since given to another process,
 * stops blocking takeovers of that lock after this long instead of forever.
 *
 * Why 50 s and not a few seconds: a holder can stall inside the guard far
 * longer than its work takes when its process is descheduled on a heavily
 * loaded machine, or while a process is still starting inside it, which can
 * take tens of seconds under load. Clearing a live guard reopens the very race
 * the guard closes, so the threshold sits well above any such stall. The cost
 * of the margin is only that an orphaned guard blocks takeovers for under a
 * minute.
 */
const STALE_GUARD_MS = 50_000;

/**
 * Read a guard once, through one fd: its snapshot and its mtime describe the
 * same file. Null when it does not exist; undefined when it cannot be read.
 */
function readGuard(guard: string): { snap: LockSnapshot; mtimeMs: number } | null | undefined {
  let fd: number;
  try {
    fd = fs.openSync(guard, 'r');
  } catch (err) {
    return errCode(err) === 'ENOENT' ? null : undefined;
  }
  try {
    const raw = fs.readFileSync(fd, 'utf8');
    const st = fs.fstatSync(fd, { bigint: true });
    const mtimeMs = Number(st.mtimeMs);
    if (process.platform === 'win32') return { snap: { raw, ino: null, dev: null }, mtimeMs };
    return { snap: { raw, ino: st.ino, dev: st.dev }, mtimeMs };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Clear a guard that no live taker is inside: one whose pid is dead (its
 * taker crashed inside it), or one whose file is older than
 * {@link STALE_GUARD_MS} whatever its pid or body (its taker was killed inside
 * it and the pid has since been reused, or it died in the O_EXCL fallback's
 * create-then-write window and left the guard empty). A younger empty or
 * malformed guard is held, not cleared: it is usually a live taker in that
 * window. Age is the guard file's mtime against this process's clock, so on a
 * network mount whose server clock runs more than {@link STALE_GUARD_MS}
 * behind this machine's a live guard can read as stale.
 *
 * Accepted residual: this clear is itself check-then-unlink. It can remove a
 * live guard only if a taker dies holding the guard (or its guard ages past
 * the threshold) and two other takers then clear that guard at the same
 * moment: the second removes the first's fresh guard, so both run inside the
 * guard.
 */
function clearDeadGuard(guard: string): boolean {
  const read = readGuard(guard);
  if (read === null) return true;
  if (read === undefined) return false;
  const { snap, mtimeMs } = read;
  const old = Date.now() - mtimeMs > STALE_GUARD_MS;
  const text = snap.raw.trim();
  if (!old && !/^\d+$/.test(text)) return false;
  const pid = Number(text);
  // Our own pid in a guard we do not hold is treated as a leftover (an
  // earlier process with this pid, or a release of ours that failed). This
  // assumes no other thread of this process takes over the same lock: the
  // guard records a pid, not a thread. True today: the worker threads (query
  // and freshness workers, parse, resolve and store workers) never call a lock
  // acquire or takeover; those run on the main thread only.
  // A live pid holds the guard only while the guard is young.
  if (!old && pid !== process.pid && pid > 0 && isAlive(pid)) return false;
  const cur = snapshotForCompare(guard);
  if (cur === null) return true;
  if (cur === undefined || !sameLock(cur, snap)) return false;
  try { fs.unlinkSync(guard); } catch (err) { if (errCode(err) !== 'ENOENT') return false; }
  return true;
}

/**
 * The pid recorded in `${lockPath}.takeover`, for a refusal message after
 * {@link removeLockIfUnchanged} returned 'busy': the guard's body when it is a
 * bare pid above zero and not this process's own, otherwise undefined (no
 * guard, unreadable, empty or malformed, or this process's enclosing
 * takeover). It is one read made after the busy result, so it names whoever
 * holds the guard at that moment, which may already be a later taker; it only
 * labels the refusal and decides nothing.
 */
export function takeoverGuardHolder(lockPath: string): number | undefined {
  const read = readGuard(`${lockPath}.takeover`);
  if (!read) return undefined;
  const text = read.snap.raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  return pid > 0 && pid !== process.pid ? pid : undefined;
}

function acquireGuard(guard: string): boolean {
  if (heldGuards.has(guard)) return false;
  for (let attempt = 0; ; attempt++) {
    if (tryCreateGuard(guard)) return true;
    if (clearDeadGuard(guard) && tryCreateGuard(guard)) return true;
    const delay = BUSY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return false;
    sleepSync(delay);
  }
}

/** Remove the guard only if it is still the one this process created. */
function releaseGuard(guard: string, mine: LockSnapshot | null): void {
  if (mine === null) return;
  const cur = snapshotForCompare(guard);
  if (!cur || !sameLock(cur, mine)) return;
  try { fs.unlinkSync(guard); } catch { /* gone, or the unlink failed (Windows while the file is open; a read-only directory on POSIX) */ }
}

/**
 * Run `fn` while holding `${lockPath}.takeover`. Returns `{ kind: 'busy' }`
 * without running `fn` when another live process holds the guard after the
 * bounded retry. The guard is removed on every return path, including a throw
 * from `fn` (which is rethrown), and only if it is still ours, unless it can no
 * longer be read back or its unlink fails (Windows while the file is open; a read-only directory on POSIX).
 * Such a leftover holds this pid; this process's next takeover of the lock clears it, and another
 * process's does once this process has exited, or once it is older than
 * {@link STALE_GUARD_MS}. A guard left by a dead process, or older than that
 * whatever its pid, is cleared and the create tried again. So `fn` must be
 * brief (a compare and an unlink, as its caller makes):
 * another taker clears a guard held longer than {@link STALE_GUARD_MS}.
 */
export function withTakeoverGuard<T>(lockPath: string, fn: () => T): { kind: 'ran'; value: T } | { kind: 'busy' } {
  const guard = `${lockPath}.takeover`;
  if (!acquireGuard(guard)) return { kind: 'busy' };
  heldGuards.add(guard);
  let mine: LockSnapshot | null = null;
  try {
    mine = snapshotLock(guard);
    return { kind: 'ran', value: fn() };
  } finally {
    heldGuards.delete(guard);
    releaseGuard(guard, mine);
  }
}

/**
 * Remove `lockPath` if it is still exactly the file the caller snapshotted
 * and judged stale. The removal is `fs.unlinkSync(lockPath)` with the path as
 * given, while holding the guard. An unlink error other than ENOENT throws.
 */
export function removeLockIfUnchanged(lockPath: string, judged: LockSnapshot): 'removed' | 'gone' | 'changed' | 'busy' {
  const r = withTakeoverGuard(lockPath, (): 'removed' | 'gone' | 'changed' => {
    const cur = snapshotForCompare(lockPath);
    if (cur === null) return 'gone';
    if (cur === undefined || !sameLock(cur, judged)) return 'changed';
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return 'gone';
      throw err;
    }
    return 'removed';
  });
  return r.kind === 'busy' ? 'busy' : r.value;
}
