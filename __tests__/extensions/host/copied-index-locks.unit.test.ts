/**
 * Lock records carry the identity of the physical index they were written
 * for: writer.pid, rebuild.pid, daemon.pid and codegraph.lock.
 *
 * A project copied with its `.codegraph/` (cp -R, rsync, a template checkout)
 * carries the ORIGINAL's lock records: daemon.pid, writer.pid, rebuild.pid and
 * codegraph.lock all name the original's live daemon. Every record carries a
 * lock stamp: the writer's canonical project root and the `dev:ino` of the
 * `.codegraph` directory and of `codegraph.db` it had open. A record is
 * foreign, and stale exactly like a dead pid, when its recorded root is
 * another project's AND it carries both identities AND NEITHER matches this
 * project's index as it is now AND this project's database has one hard link.
 * A copy at another path has a new root, a new directory and a new database
 * with one link, so its records are foreign. Not foreign, so pid liveness
 * decides: a record at this same root (also a `.codegraph/` moved aside and
 * copied back in place, with both inodes new: its live holder follows the
 * replaced database there), a move within one filesystem (both inodes kept),
 * any record at a project whose database has more than one hard link (shared,
 * whatever the record's stamp says), and a record with no root or no identity
 * (older formats, including one that names only a root). A root alone never
 * decides.
 *
 * Inode identity is POSIX-only: on Windows no record carries one, so every
 * record is decided by pid liveness there. Tests that need a foreign record
 * are gated to POSIX for that reason.
 *
 * "Live other pid" is a parked child process: genuinely alive on every
 * platform and never ours, so liveness alone says "held".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot } from '../../../src/directory';
import {
  decodeWriterLockInfo,
  getWriterPidPath,
  isForeignLockRecord,
  isRebuildInProgress,
  lockStamp,
  markWriterReady,
  readWriterLock,
  releaseWriterLock,
  swapWriterLock,
  tryAcquireWriterLock,
} from '../../../src/mcp/writer-lock';
import { decodeLockInfo, encodeLockInfo, getDaemonPidPath, getDaemonSocketPath } from '../../../src/mcp/daemon-paths';
import { Daemon, clearStaleDaemonLock, tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import { getRegistryDir, isProcessAlive, stopOlderDaemon } from '../../../src/mcp/daemon-registry';
import { MCPEngine } from '../../../src/mcp/engine';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { FileLock } from '../../../src/utils';

const posix = process.platform !== 'win32';

/** `dev:ino` of a path, read as bigints, as the lock stamp records it. */
function inodeOf(p: string): string {
  const s = fs.statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}`;
}

/** Make `root` an index: `.codegraph/` with a `codegraph.db` file in it. */
function makeIndexAt(root: string): void {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codegraph', 'codegraph.db'), 'db');
}

describe('copied-index-locks: lock records carry the identity of their index', () => {
  const dirs: string[] = [];
  let holder: ChildProcess | null = null;

  afterEach(() => {
    try { holder?.kill('SIGKILL'); } catch { /* already gone */ }
    holder = null;
    for (const d of dirs.splice(0)) {
      releaseWriterLock(d);
      releaseWriterLock(d, 'rebuild.pid');
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /** An initialized-looking project: `<dir>/.codegraph/codegraph.db` exists. */
  function makeProject(tag: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `cg-copied-${tag}-`));
    makeIndexAt(d);
    dirs.push(d);
    return d;
  }

  /** A path beside nothing yet, removed with the other fixtures. */
  function freshPath(tag: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `cg-copied-${tag}-`));
    fs.rmSync(d, { recursive: true, force: true });
    dirs.push(d);
    return d;
  }

  /** A live pid that is not ours. */
  function liveOtherPid(): number {
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Failed to spawn the live holder process');
    return holder.pid;
  }

  function plantWriter(root: string, record: Record<string, unknown>, lockName: 'writer.pid' | 'rebuild.pid' = 'writer.pid'): void {
    fs.writeFileSync(getWriterPidPath(root, lockName), JSON.stringify(record) + '\n', { flag: 'wx' });
  }

  /** The record a live writer on `root` wrote: `pid` and `root`'s lock stamp as it is now. */
  function writerRecord(pid: number, root?: string): Record<string, unknown> {
    return { pid, mode: 'daemon', startedAt: Date.now(), ready: true, ...(root !== undefined ? lockStamp(root) : {}) };
  }

  /** Copy a project with its index, as cp -R does: new directory and database inodes. */
  function copyProject(from: string, tag: string): string {
    const to = freshPath(tag);
    fs.cpSync(from, to, { recursive: true });
    return to;
  }

  // ---------------------------------------------------------------- the rule

  it.runIf(posix)('lockStamp records the canonical root and the dev:ino of .codegraph and codegraph.db', () => {
    const a = makeProject('a');
    expect(lockStamp(a)).toEqual({
      root: canonicalProjectRoot(a),
      dirId: inodeOf(path.join(a, '.codegraph')),
      dbId: inodeOf(path.join(a, '.codegraph', 'codegraph.db')),
    });
  });

  it('lockStamp carries no identity when the database is missing', () => {
    const a = makeProject('a');
    fs.rmSync(path.join(a, '.codegraph', 'codegraph.db'));
    expect(lockStamp(a)).toEqual({ root: canonicalProjectRoot(a) });
  });

  it.runIf(process.platform === 'win32')('on Windows lockStamp carries no identity, so no record is foreign', () => {
    const a = makeProject('a');
    const b = copyProject(a, 'b');
    expect(lockStamp(a)).toEqual({ root: canonicalProjectRoot(a) });
    expect(isForeignLockRecord({ root: canonicalProjectRoot(a), dirId: '1:2', dbId: '1:3' }, b)).toBe(false);
  });

  it.runIf(posix)('isForeignLockRecord: foreign only at another root, with both identities, neither matching', () => {
    const a = makeProject('a');
    const b = copyProject(a, 'b');
    const stampA = lockStamp(a);
    const stampB = lockStamp(b);
    const rootA = canonicalProjectRoot(a);
    expect(isForeignLockRecord(stampA, b)).toBe(true);
    expect(isForeignLockRecord(stampA, a)).toBe(false);
    // One identity matching is enough to be this index.
    expect(isForeignLockRecord({ root: stampB.root, dirId: stampA.dirId, dbId: stampB.dbId }, a)).toBe(false);
    expect(isForeignLockRecord({ root: stampB.root, dirId: stampB.dirId, dbId: stampA.dbId }, a)).toBe(false);
    // The recorded root is this project's: never foreign, even with both identities another index's.
    expect(isForeignLockRecord({ ...stampA, root: stampB.root }, b)).toBe(false);
    // No root, an empty one or a mistyped one: not foreign.
    expect(isForeignLockRecord({ dirId: stampA.dirId, dbId: stampA.dbId }, b)).toBe(false);
    expect(isForeignLockRecord({ ...stampA, root: '' }, b)).toBe(false);
    expect(isForeignLockRecord({ ...stampA, root: 7 }, b)).toBe(false);
    // The recorded root is compared exactly as recorded, never trimmed: a
    // root that differs from this one only by a trailing space is another root.
    expect(isForeignLockRecord({ ...stampA, root: `${stampB.root} ` }, b)).toBe(true);
    // No identity, a partial one or a mistyped one is no identity.
    expect(isForeignLockRecord({ root: rootA }, b)).toBe(false);
    expect(isForeignLockRecord({ root: rootA, dirId: stampA.dirId }, b)).toBe(false);
    expect(isForeignLockRecord({ root: rootA, dirId: 1, dbId: 2 }, b)).toBe(false);
    expect(isForeignLockRecord({ root: rootA, dirId: '', dbId: '' }, b)).toBe(false);
    expect(isForeignLockRecord(undefined, b)).toBe(false);
    expect(isForeignLockRecord('not a record', b)).toBe(false);
    // This project's identity cannot be read: not foreign.
    fs.rmSync(path.join(b, '.codegraph', 'codegraph.db'));
    expect(isForeignLockRecord(stampA, b)).toBe(false);
  });

  // -------------------------------------------------------------- writer.pid

  it.runIf(posix)('a copied writer.pid naming a live pid is stale in the copy: readWriterLock is null and acquire wins', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    const b = copyProject(a, 'b');

    expect(readWriterLock(b)).toBeNull();
    const r = tryAcquireWriterLock(b, 'daemon');
    expect(r.kind).toBe('acquired');
    const onDisk = decodeWriterLockInfo(fs.readFileSync(getWriterPidPath(b), 'utf8'));
    expect(onDisk?.pid).toBe(process.pid);
    expect(onDisk).toMatchObject(lockStamp(b));
    // The original keeps its live holder.
    expect(readWriterLock(a)?.pid).toBe(h);
  });

  it.runIf(posix)('decodeWriterLockInfo passes the stamp through, and is null for a foreign record when given the project', () => {
    const a = makeProject('a');
    const b = copyProject(a, 'b');
    const raw = JSON.stringify(writerRecord(1234, a));
    expect(decodeWriterLockInfo(raw)).toMatchObject(lockStamp(a));
    expect(decodeWriterLockInfo(raw, b)).toBeNull();
    expect(decodeWriterLockInfo(raw, a)?.pid).toBe(1234);
  });

  it('a writer.pid naming a live pid, written for THIS index, is taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    const r = tryAcquireWriterLock(a, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
  });

  it('an old-format writer.pid (no stamp) naming a live pid is taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h));
    const r = tryAcquireWriterLock(a, 'daemon');
    expect(r.kind).toBe('taken');
    expect(readWriterLock(a)?.pid).toBe(h);
  });

  it('a writer.pid naming only a root, of another existing index, is decided by pid liveness: taken', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const h = liveOtherPid();
    plantWriter(a, { pid: h, mode: 'daemon', startedAt: Date.now(), ready: true, root: canonicalProjectRoot(b) });
    const r = tryAcquireWriterLock(a, 'daemon');
    expect(r.kind).toBe('taken');
    expect(readWriterLock(a)?.pid).toBe(h);
  });

  it('a live writer\'s project moved away, with a new index created at its old path, is still taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    const b = freshPath('b');
    fs.renameSync(a, b);
    makeIndexAt(a);

    const r = tryAcquireWriterLock(b, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
    expect(readWriterLock(b)?.pid).toBe(h);
  });

  it('a project whose codegraph.db is a hardlink of a live writer\'s database is taken', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const dbB = path.join(b, '.codegraph', 'codegraph.db');
    fs.rmSync(dbB);
    fs.linkSync(path.join(a, '.codegraph', 'codegraph.db'), dbB);
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    fs.copyFileSync(getWriterPidPath(a), getWriterPidPath(b));

    const r = tryAcquireWriterLock(b, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
  });

  it('a live writer.pid stays taken after codegraph.db is recreated in the same directory', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    const db = path.join(a, '.codegraph', 'codegraph.db');
    const before = lockStamp(a).dbId;
    // Written beside the old file and renamed over it, so the inode is new.
    fs.writeFileSync(`${db}.new`, 'rebuilt');
    fs.renameSync(`${db}.new`, db);
    if (posix) expect(lockStamp(a).dbId).not.toBe(before);

    const r = tryAcquireWriterLock(a, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
  });

  it('the acquired writer.pid records the stamp, markWriterReady keeps it, and swapWriterLock writes its record verbatim', () => {
    const a = makeProject('a');
    const want = lockStamp(a);
    expect(tryAcquireWriterLock(a, 'daemon').kind).toBe('acquired');
    const readRaw = () => JSON.parse(fs.readFileSync(getWriterPidPath(a), 'utf8')) as Record<string, unknown>;
    expect(readRaw()).toMatchObject(want);

    markWriterReady(a);
    expect(readRaw().ready).toBe(true);
    expect(readRaw()).toMatchObject(want);

    // A hand-back restores the previous holder's record exactly, so the swap
    // adds nothing: an unstamped record stays unstamped, a stamped one keeps its stamp.
    const unstamped = { pid: process.pid, mode: 'daemon', startedAt: 1, ready: true };
    expect(swapWriterLock(a, process.pid, unstamped)).toBe(true);
    expect(readRaw()).toEqual(unstamped);
    const stamped = { pid: process.pid, mode: 'daemon', startedAt: 2, ready: false, ...want };
    expect(swapWriterLock(a, process.pid, stamped)).toBe(true);
    expect(readRaw()).toEqual(stamped);
  });

  it.runIf(posix)('a copied rebuild.pid is not a rebuild in progress; one of this index is', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, { ...writerRecord(h, a), mode: 'rebuild' }, 'rebuild.pid');
    expect(isRebuildInProgress(a)).toBe(true);

    const b = copyProject(a, 'b');
    expect(isRebuildInProgress(b)).toBe(false);
  });

  // -------------------------------------------------------------- daemon.pid

  /** The daemon.pid a live daemon serving `root` wrote, stamped for `stampRoot` (none when undefined). */
  function daemonRecord(pid: number, root: string, stampRoot?: string): string {
    return encodeLockInfo({
      pid,
      version: CodeGraphPackageVersion,
      socketPath: getDaemonSocketPath(root),
      startedAt: Date.now(),
      ...(stampRoot !== undefined ? lockStamp(stampRoot) : {}),
    });
  }

  it.runIf(posix)('decodeLockInfo is null for a copied daemon.pid when given the copy, and passes the stamp through without it', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    const raw = daemonRecord(h, a, a);
    fs.writeFileSync(getDaemonPidPath(a), raw);
    const b = copyProject(a, 'b');

    expect(decodeLockInfo(raw, b)).toBeNull();
    expect(decodeLockInfo(raw)).toMatchObject(lockStamp(a));
    expect(decodeLockInfo(raw, a)?.pid).toBe(h);
  });

  it.runIf(posix)('clearStaleDaemonLock with projectRoot clears a copied daemon.pid even though its pid is alive', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    const raw = daemonRecord(h, a, a);
    fs.writeFileSync(getDaemonPidPath(a), raw);
    const b = copyProject(a, 'b');
    const pidPath = getDaemonPidPath(b);

    expect(clearStaleDaemonLock(pidPath, undefined, { expectedLockContents: raw, projectRoot: b })).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
    expect(fs.readFileSync(getDaemonPidPath(a), 'utf8')).toBe(raw);
  });

  it('clearStaleDaemonLock keeps a live daemon.pid written for this index', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    const raw = daemonRecord(h, a, a);
    const pidPath = getDaemonPidPath(a);
    fs.writeFileSync(pidPath, raw);

    expect(clearStaleDaemonLock(pidPath, undefined, { expectedLockContents: raw, projectRoot: a })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(raw);
  });

  it('clearStaleDaemonLock keeps a live old-format daemon.pid with no stamp', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const h = liveOtherPid();
    const raw = daemonRecord(h, b);
    const pidPath = getDaemonPidPath(a);
    fs.writeFileSync(pidPath, raw);

    expect(clearStaleDaemonLock(pidPath, undefined, { expectedLockContents: raw, projectRoot: a })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(raw);
  });

  it.runIf(posix)('a copy whose original was then moved never reads the original\'s live daemon as its own', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    const raw = daemonRecord(h, a, a);
    fs.writeFileSync(getDaemonPidPath(a), raw);
    const b = copyProject(a, 'b');
    const c = freshPath('c');
    fs.renameSync(a, c);
    const pidPath = getDaemonPidPath(b);

    expect(decodeLockInfo(fs.readFileSync(pidPath, 'utf8'), b)).toBeNull();
    expect(clearStaleDaemonLock(pidPath, undefined, { projectRoot: b })).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
    // The moved original still owns its record.
    expect(decodeLockInfo(fs.readFileSync(getDaemonPidPath(c), 'utf8'), c)?.pid).toBe(h);
  });

  it('tryAcquireDaemonLock on a fresh project records the lock stamp', () => {
    const a = makeProject('a');
    const r = tryAcquireDaemonLock(a);
    expect(r.kind).toBe('acquired');
    const onDisk = JSON.parse(fs.readFileSync(getDaemonPidPath(a), 'utf8')) as Record<string, unknown>;
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk).toMatchObject(lockStamp(a));
  });

  // ---------------------------------------------------------- codegraph.lock

  function ownerFor(root: string): { stamp(): object; isForeign(record: unknown): boolean } {
    return { stamp: () => lockStamp(root), isForeign: (r: unknown) => isForeignLockRecord(r, root) };
  }

  /** The body a live holder of `root`'s codegraph.lock wrote: its pid, then `root`'s stamp. */
  function fileLockBody(pid: number, root: string): string {
    return `${pid}\n${JSON.stringify(lockStamp(root))}`;
  }

  it.runIf(posix)('a copied codegraph.lock naming a live pid is taken over in the copy, and the body carries the copy\'s stamp', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    fs.writeFileSync(path.join(a, '.codegraph', 'codegraph.lock'), fileLockBody(h, a));
    const b = copyProject(a, 'b');
    const lockPath = path.join(b, '.codegraph', 'codegraph.lock');

    const lock = new FileLock(lockPath, ownerFor(b));
    try {
      expect(() => lock.acquire()).not.toThrow();
      const body = fs.readFileSync(lockPath, 'utf8');
      expect(body).toBe(fileLockBody(process.pid, b));
      // Readers that parseInt the body still get the pid.
      expect(parseInt(body.trim(), 10)).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('a codegraph.lock naming a live pid, written for this index, still refuses', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    const lockPath = path.join(a, '.codegraph', 'codegraph.lock');
    fs.writeFileSync(lockPath, fileLockBody(h, a));

    const lock = new FileLock(lockPath, ownerFor(a));
    expect(() => lock.acquire()).toThrow(/locked by another process/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(fileLockBody(h, a));
  });

  it('an old-format codegraph.lock (pid only, or pid and a bare root line) naming a live pid still refuses', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const h = liveOtherPid();
    const lockPath = path.join(a, '.codegraph', 'codegraph.lock');
    for (const body of [`${h}`, `${h}\n${canonicalProjectRoot(b)}`]) {
      fs.writeFileSync(lockPath, body);
      const lock = new FileLock(lockPath, ownerFor(a));
      expect(() => lock.acquire()).toThrow(/locked by another process/);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(body);
    }
  });

  /**
   * The holder's record is written by FileLock itself, then handed to a
   * live pid that is not ours, so the contender reads exactly the bytes a
   * holder of this project writes. A sibling index sits at the path the
   * recorded root would read as if it were trimmed or cut at a newline.
   */
  function holdAsLiveOther(project: string): string {
    const lockPath = path.join(project, '.codegraph', 'codegraph.lock');
    const mine = new FileLock(lockPath, ownerFor(project));
    mine.acquire();
    const body = fs.readFileSync(lockPath, 'utf8');
    fs.writeFileSync(lockPath, body.replace(/^\d+/, String(liveOtherPid())));
    return body;
  }

  it.runIf(posix)('a project path ending in a space keeps its live codegraph.lock while an index exists at the trimmed path', () => {
    const parent = freshPath('space');
    const spaced = path.join(parent, 'project ');
    makeIndexAt(spaced);
    makeIndexAt(path.join(parent, 'project'));

    const body = holdAsLiveOther(spaced);
    expect(JSON.parse(body.split('\n')[1]).root).toBe(canonicalProjectRoot(spaced));

    const contender = new FileLock(path.join(spaced, '.codegraph', 'codegraph.lock'), ownerFor(spaced));
    expect(() => contender.acquire()).toThrow(/locked by another/);
  });

  it.runIf(posix)('a project path containing a newline round-trips its root and keeps its live codegraph.lock', () => {
    const parent = freshPath('newline');
    const project = path.join(parent, 'a\nb');
    makeIndexAt(project);
    makeIndexAt(path.join(parent, 'a'));

    const body = holdAsLiveOther(project);
    expect(body.split('\n')).toHaveLength(2);
    expect(JSON.parse(body.split('\n')[1]).root).toBe(canonicalProjectRoot(project));

    const contender = new FileLock(path.join(project, '.codegraph', 'codegraph.lock'), ownerFor(project));
    expect(() => contender.acquire()).toThrow(/locked by another/);
  });

  // ------------------------------------------- a .codegraph restored in place

  /**
   * Move `root`'s `.codegraph/` aside and copy it back to the same path, lock
   * files included, as a backup restore does: new directory and database
   * inodes, the same root. A live holder at that root follows the replaced
   * database (`CodeGraph.reopenIfReplaced`), so its records must stay its own.
   * Asserts the premise: both identities changed.
   */
  function restoreInPlace(root: string): void {
    const before = lockStamp(root);
    const dir = path.join(root, '.codegraph');
    const aside = path.join(root, '.codegraph-aside');
    fs.renameSync(dir, aside);
    fs.cpSync(aside, dir, { recursive: true });
    if (posix) {
      const after = lockStamp(root);
      expect(after.root).toBe(before.root);
      expect(after.dirId).not.toBe(before.dirId);
      expect(after.dbId).not.toBe(before.dbId);
    }
  }

  it('a live writer.pid and rebuild.pid restored to the same path are still held', () => {
    const p = makeProject('p');
    const h = liveOtherPid();
    plantWriter(p, writerRecord(h, p));
    plantWriter(p, { ...writerRecord(h, p), mode: 'rebuild' }, 'rebuild.pid');
    restoreInPlace(p);

    const r = tryAcquireWriterLock(p, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
    expect(readWriterLock(p)?.pid).toBe(h);
    expect(isRebuildInProgress(p)).toBe(true);
  });

  it('a live daemon.pid restored to the same path still names this project\'s daemon', () => {
    const p = makeProject('p');
    const h = liveOtherPid();
    const raw = daemonRecord(h, p, p);
    const pidPath = getDaemonPidPath(p);
    fs.writeFileSync(pidPath, raw);
    restoreInPlace(p);

    expect(decodeLockInfo(fs.readFileSync(pidPath, 'utf8'), p)?.pid).toBe(h);
    expect(clearStaleDaemonLock(pidPath, undefined, { expectedLockContents: raw, projectRoot: p })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(raw);
  });

  it('a live codegraph.lock restored to the same path still refuses', () => {
    const p = makeProject('p');
    const h = liveOtherPid();
    const lockPath = path.join(p, '.codegraph', 'codegraph.lock');
    const body = fileLockBody(h, p);
    fs.writeFileSync(lockPath, body);
    restoreInPlace(p);

    const lock = new FileLock(lockPath, ownerFor(p));
    expect(() => lock.acquire()).toThrow(/locked by another process/);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(body);
  });

  // A writer's stamp names the index it first opened. Its holder follows a
  // database restored in place, so a later hardlink of that database into
  // another project shares neither recorded identity: the record's root and
  // both ids differ there, and only the database's link count shows the
  // database is shared.
  it('a live writer.pid copied beside a hardlink of its restored database is taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    restoreInPlace(a);
    const b = makeProject('b');
    const dbB = path.join(b, '.codegraph', 'codegraph.db');
    fs.rmSync(dbB);
    fs.linkSync(path.join(a, '.codegraph', 'codegraph.db'), dbB);
    fs.copyFileSync(getWriterPidPath(a), getWriterPidPath(b));

    const r = tryAcquireWriterLock(b, 'daemon');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
    expect(readWriterLock(b)?.pid).toBe(h);
  });

  it.runIf(posix)('isForeignLockRecord is false at a project whose codegraph.db has more than one link', () => {
    const a = makeProject('a');
    const b = copyProject(a, 'b');
    const stampA = lockStamp(a);
    const stampB = lockStamp(b);
    expect(isForeignLockRecord(stampA, b)).toBe(true);
    const second = path.join(b, 'second-name.db');
    fs.linkSync(path.join(b, '.codegraph', 'codegraph.db'), second);
    // The link changes no identity: root, directory and database all still differ.
    expect(lockStamp(b)).toEqual(stampB);
    expect(isForeignLockRecord(stampA, b)).toBe(false);
    fs.rmSync(second);
    expect(isForeignLockRecord(stampA, b)).toBe(true);
  });
});

/**
 * The launcher's handover claim (stopOlderDaemon taking the writer slot
 * from an older daemon before it signals it) carries this project's lock
 * stamp, so a copy of this index that inherits the claim reads it as foreign.
 * The claim is built with its stamp at the claim site; swapWriterLock writes
 * records verbatim. Harness copied from daemon-older-version.test.ts: a
 * detached stand-in process, a socket answering the older daemon's hello, and
 * its daemon.pid.
 */
describe('copied-index-locks: the handover claim carries its lock stamp', () => {
  let root: string;
  let server: net.Server | null;
  let pids: number[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-copied-handover-'));
    makeIndexAt(root);
    server = null;
    pids = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A live process to stand in for a daemon; signals reach it, never the test. */
  function startDetachedProcess(): number {
    const source = [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'child.unref();',
      'console.log(child.pid);',
    ].join(' ');
    const pid = Number(execFileSync(process.execPath, ['-e', source], { encoding: 'utf8' }).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('could not start daemon fixture');
    return pid;
  }

  /** A daemon of `version`: its daemon.pid, and a socket answering the hello as it. */
  async function fakeDaemon(version: string): Promise<number> {
    const pid = startDetachedProcess();
    pids.push(pid);
    const socketPath = getDaemonSocketPath(root);
    server = net.createServer((socket) => {
      socket.end(JSON.stringify({ protocol: 1, codegraph: version, pid, socketPath }) + '\n');
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, resolve);
    });
    fs.writeFileSync(getDaemonPidPath(root), encodeLockInfo({ pid, version, socketPath, startedAt: Date.now() }));
    return pid;
  }

  const writerRecord = (): any => {
    try { return JSON.parse(fs.readFileSync(getWriterPidPath(root), 'utf8')); } catch { return null; }
  };

  it('the writer.pid at SIGTERM time is a handover claim carrying lockStamp(root)', async () => {
    const pid = await fakeDaemon('1.6.1');
    // The older daemon's own record is unstamped (the older format), so the
    // claim's stamp can only come from the claim site.
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({ pid, mode: 'daemon', startedAt: 1, ready: true }) + '\n');
    let atSignal: any = null;
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal === 'SIGTERM') atSignal = writerRecord();
      return originalKill(target, signal);
    });
    expect(await stopOlderDaemon(root, '1.6.2')).toMatchObject({ pid, outcome: 'term' });
    expect(atSignal).toMatchObject({ pid: process.pid, mode: 'handover', ...lockStamp(root) });
    expect(atSignal.root).toBe(canonicalProjectRoot(root));
  }, 15000);
});

/**
 * The discovery entry a daemon files in the registry (`codegraph list`,
 * `stop --all`) names the root the daemon was started with, and carries no
 * lock stamp: the stamp's canonical `root` (realpath'd, lowercased on Windows)
 * must not replace it, and `dirId` / `dbId` belong to the pidfile only.
 *
 * Runs a Daemon in this process with its engine stubbed, so no index is
 * opened, and `process.exit` stubbed for `stop()`. POSIX only: on Windows
 * `stop()` arms a real exit backstop that fires after the stubs are restored.
 * The daemon is given the project through a symlink, so its canonical root
 * (the stamp's) differs from the root it was started with.
 */
describe('copied-index-locks: the registry entry keeps the root the daemon was started with', () => {
  it.runIf(posix)('Daemon.start registers { root, pid, version, socketPath, startedAt } and no stamp', async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-copied-registry-'));
    makeIndexAt(real);
    const root = `${real}-link`;
    fs.symlinkSync(real, root, 'dir');
    expect(canonicalProjectRoot(root)).not.toBe(root);
    vi.spyOn(MCPEngine.prototype, 'ensureInitialized').mockResolvedValue(undefined);
    vi.spyOn(MCPEngine.prototype, 'stop').mockResolvedValue(undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const signals = ['SIGINT', 'SIGTERM'] as const;
    const before = new Map(signals.map((s) => [s, process.listeners(s)]));

    expect(tryAcquireDaemonLock(root).kind).toBe('acquired');
    const daemon = new Daemon(root, { idleTimeoutMs: 0 });
    try {
      const started = await daemon.start();
      const entries = fs.readdirSync(getRegistryDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(getRegistryDir(), f), 'utf8')) as Record<string, unknown>)
        .filter((e) => e.pid === process.pid && e.socketPath === started.socketPath);
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(Object.keys(entry)).toEqual(['root', 'pid', 'version', 'socketPath', 'startedAt']);
      expect(entry).toEqual({
        root,
        pid: process.pid,
        version: CodeGraphPackageVersion,
        socketPath: started.socketPath,
        startedAt: started.lock.startedAt,
      });
      // The pidfile, unlike the registry entry, carries the stamp.
      expect(started.lock).toMatchObject(lockStamp(root));
    } finally {
      await daemon.stop('test');
      for (const s of signals) {
        for (const l of process.listeners(s)) if (!before.get(s)!.includes(l)) process.removeListener(s, l);
      }
      vi.restoreAllMocks();
      fs.rmSync(root, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
