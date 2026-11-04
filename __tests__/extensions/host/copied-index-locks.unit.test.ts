/**
 * Lock records carry the identity of the physical index they were written
 * for: writer.pid, rebuild.pid and codegraph.lock. The machine server's
 * server.pid lives separately in its state dir and carries no project stamp.
 *
 * A project copied with its `.codegraph/` (cp -R, rsync, a template checkout)
 * carries the ORIGINAL's writer.pid, rebuild.pid and codegraph.lock, all
 * naming the original's live writer. Each of these project records carries a
 * lock stamp: the writer's canonical project root and the `dev:ino` of the
 * `.codegraph` directory and of `codegraph.db` it had open. A record is
 * foreign, and stale exactly like a dead pid, when its recorded root is
 * another project's AND it carries both identities AND NEITHER matches this
 * project's index as it is now AND the recorded root's `.codegraph` and
 * database are not this project's now AND this project's database has one
 * hard link. A copy at another path has a new root, a new directory and a new
 * database with one link, so its records are foreign. Not foreign, so pid
 * liveness decides: a record at this same root (also a `.codegraph/` moved
 * aside and copied back in place, with both inodes new: its live holder
 * follows the replaced database there), a move within one filesystem (both
 * inodes kept), a project whose `.codegraph` is a symlink to the recorded
 * root's or whose database is the recorded root's database now (two
 * `codegraph.db` symlinks to one external file), any record at a project whose
 * database has more than one hard link (shared, whatever the record's stamp
 * says), and a record with no root or no identity (older formats, including
 * one that names only a root). A root alone never decides.
 *
 * Inode identity is POSIX-only: on Windows no record carries one, so every
 * record is decided by pid liveness there. Tests that need a foreign record
 * are gated to POSIX for that reason.
 *
 * "Live other pid" is a parked child process: genuinely alive on every
 * platform and never ours, so liveness alone says "held".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
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
  tryAcquireWriterLock,
} from '../../../src/mcp/writer-lock';
import { getStateDirIdentity } from '../../../src/extensions/host/server/state-dir';
import { decodeServerLock, encodeServerLock, getServerPidPath, getServerSocketPath } from '../../../src/mcp/daemon-paths';
import { clearStaleDaemonLock, tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { FileLock } from '../../../src/utils';
import { processStartTime } from '../../../src/mcp/process-identity';

const posix = process.platform !== 'win32';

/** The writer fields lockStamp adds for this process: its pid, and its start time where one is read. */
const ownWriter = { pid: process.pid, ...(posix ? { pidStart: expect.any(String) } : {}) };

/**
 * `root`'s lock stamp as process `pid` would write it: the stamp's writer
 * fields (`pid`, `pidStart`) are that process's, so a record planted for a
 * live `pid` is that holder's own, not one whose pid looks reused.
 */
function stampAs(pid: number, root: string): Record<string, unknown> {
  const start = processStartTime(pid);
  const { pidStart: _own, ...stamp } = lockStamp(root);
  return { ...stamp, pid, ...(start !== null ? { pidStart: start } : {}) };
}

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
    return { pid, mode: 'fallback', startedAt: Date.now(), ready: true, ...(root !== undefined ? stampAs(pid, root) : {}) };
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
      ...ownWriter,
    });
  });

  it('lockStamp carries no identity when the database is missing', () => {
    const a = makeProject('a');
    fs.rmSync(path.join(a, '.codegraph', 'codegraph.db'));
    expect(lockStamp(a)).toEqual({ root: canonicalProjectRoot(a), ...ownWriter });
  });

  it.runIf(process.platform === 'win32')('on Windows lockStamp carries no identity, so no record is foreign', () => {
    const a = makeProject('a');
    const b = copyProject(a, 'b');
    expect(lockStamp(a)).toEqual({ root: canonicalProjectRoot(a), ...ownWriter });
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
    const r = tryAcquireWriterLock(b, 'fallback');
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
    expect(decodeWriterLockInfo(raw)).toMatchObject(stampAs(1234, a));
    expect(decodeWriterLockInfo(raw, b)).toBeNull();
    expect(decodeWriterLockInfo(raw, a)?.pid).toBe(1234);
  });

  it('a writer.pid naming a live pid, written for THIS index, is taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h, a));
    const r = tryAcquireWriterLock(a, 'fallback');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
  });

  it('an old-format writer.pid (no stamp) naming a live pid is taken', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, writerRecord(h));
    const r = tryAcquireWriterLock(a, 'fallback');
    expect(r.kind).toBe('taken');
    expect(readWriterLock(a)?.pid).toBe(h);
  });

  it('a writer.pid naming only a root, of another existing index, is decided by pid liveness: taken', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const h = liveOtherPid();
    plantWriter(a, { pid: h, mode: 'fallback', startedAt: Date.now(), ready: true, root: canonicalProjectRoot(b) });
    const r = tryAcquireWriterLock(a, 'fallback');
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

    const r = tryAcquireWriterLock(b, 'fallback');
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

    const r = tryAcquireWriterLock(b, 'fallback');
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

    const r = tryAcquireWriterLock(a, 'fallback');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
  });

  it('the acquired writer.pid records the stamp and markWriterReady keeps it', () => {
    const a = makeProject('a');
    const want = lockStamp(a);
    expect(tryAcquireWriterLock(a, 'fallback').kind).toBe('acquired');
    const readRaw = () => JSON.parse(fs.readFileSync(getWriterPidPath(a), 'utf8')) as Record<string, unknown>;
    expect(readRaw()).toMatchObject(want);

    markWriterReady(a);
    expect(readRaw().ready).toBe(true);
    expect(readRaw()).toMatchObject(want);

  });

  it.runIf(posix)('a copied rebuild.pid is not a rebuild in progress; one of this index is', () => {
    const a = makeProject('a');
    const h = liveOtherPid();
    plantWriter(a, { ...writerRecord(h, a), mode: 'cold-build' }, 'rebuild.pid');
    expect(isRebuildInProgress(a)).toBe(true);

    const b = copyProject(a, 'b');
    expect(isRebuildInProgress(b)).toBe(false);
  });

  // ---------------------------------------------------------- codegraph.lock

  function ownerFor(root: string): { stamp(): object; isForeign(record: unknown): boolean } {
    return { stamp: () => lockStamp(root), isForeign: (r: unknown) => isForeignLockRecord(r, root) };
  }

  /** The body a live holder of `root`'s codegraph.lock wrote: its pid, then `root`'s stamp. */
  function fileLockBody(pid: number, root: string): string {
    return `${pid}\n${JSON.stringify(stampAs(pid, root))}`;
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
    plantWriter(p, { ...writerRecord(h, p), mode: 'cold-build' }, 'rebuild.pid');
    restoreInPlace(p);

    const r = tryAcquireWriterLock(p, 'fallback');
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.existing?.pid).toBe(h);
    expect(readWriterLock(p)?.pid).toBe(h);
    expect(isRebuildInProgress(p)).toBe(true);
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

    const r = tryAcquireWriterLock(b, 'fallback');
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

  // ------------------- symlinked indexes

  it.runIf(posix)('keeps a live record for a project whose .codegraph is a symlink to the recorded index, after that index is restored', () => {
    // alias/.codegraph -> source/.codegraph. The source's index directory is
    // moved aside and copied back in place (new directory and database
    // inodes, one link), which the live source writer follows. The record
    // names the old inodes and the source's root; the alias has another root
    // but reaches this same index, so the record is still held there.
    const source = makeProject('a');
    const h = liveOtherPid();
    const record = writerRecord(h, source);
    plantWriter(source, record);
    const alias = freshPath('alias');
    fs.mkdirSync(alias, { recursive: true });
    fs.symlinkSync(path.join(source, '.codegraph'), path.join(alias, '.codegraph'));
    restoreInPlace(source);

    const aliasStamp = lockStamp(alias);
    expect(aliasStamp.root).not.toBe(record.root);
    expect(aliasStamp.dirId).not.toBe(record.dirId);
    expect(aliasStamp.dbId).not.toBe(record.dbId);

    expect(isForeignLockRecord(record, alias)).toBe(false);
    expect(readWriterLock(alias)?.pid).toBe(h);
    expect(tryAcquireWriterLock(alias, 'fallback').kind).toBe('taken');
    expect(readWriterLock(source)).toMatchObject(record);
    // A real copy of the restored index is still foreign: the recorded root
    // reaches the source's index, not the copy's.
    const copy = copyProject(source, 'copy');
    expect(isForeignLockRecord(record, copy)).toBe(true);
  });

  it.runIf(posix)('keeps a live record for a copy whose codegraph.db links to an external database replaced by rename, and keeps an independent copy foreign', () => {
    // source/.codegraph/codegraph.db is a symlink to a database outside the
    // project. cp keeps that link as a link, so the copy reaches the same
    // file. The external database is then replaced by rename, which gives its
    // path a new inode; the copy's link follows it, as the source's live writer
    // does. An independent copy with its own database file is still foreign.
    const source = makeProject('a');
    const external = freshPath('external');
    fs.mkdirSync(external, { recursive: true });
    const externalDb = path.join(external, 'external.db');
    fs.writeFileSync(externalDb, 'fixture');
    fs.unlinkSync(path.join(source, '.codegraph', 'codegraph.db'));
    fs.symlinkSync(externalDb, path.join(source, '.codegraph', 'codegraph.db'));
    const h = liveOtherPid();
    const record = writerRecord(h, source);
    plantWriter(source, record);
    const target = copyProject(source, 'target');
    expect(fs.lstatSync(path.join(target, '.codegraph', 'codegraph.db')).isSymbolicLink()).toBe(true);

    const inodeBefore = inodeOf(externalDb);
    const replacement = path.join(external, 'external.db.next');
    fs.writeFileSync(replacement, 'replaced');
    fs.renameSync(replacement, externalDb);
    expect(inodeOf(externalDb)).not.toBe(inodeBefore);

    expect(isForeignLockRecord(record, target)).toBe(false);
    expect(readWriterLock(target)?.pid).toBe(h);
    expect(tryAcquireWriterLock(target, 'fallback').kind).toBe('taken');
    expect(readWriterLock(source)).toMatchObject(record);

    const independent = freshPath('independent');
    fs.cpSync(source, independent, { recursive: true, dereference: true });
    expect(isForeignLockRecord(record, independent)).toBe(true);
  });
});

/** The machine-server lock is state-scoped, not part of a copied project's index. */
describe('copied-index-locks: server lock identity is separate from project stamps', () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-copied-server-state-'));
    previousStateDir = process.env.CODEGRAPH_STATE_DIR;
    process.env.CODEGRAPH_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('clearStaleDaemonLock keeps an exact live server.pid record', () => {
    const raw = encodeServerLock({
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath: getServerSocketPath(),
      startedAt: Date.now(),
      stateDir,
      stateId: getStateDirIdentity()!,
    });
    const pidPath = getServerPidPath();
    fs.writeFileSync(pidPath, raw);

    expect(clearStaleDaemonLock(pidPath, undefined, { expectedLockContents: raw })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(raw);
  });

  it('tryAcquireDaemonLock writes only the machine-server identity fields in the state dir', () => {
    const acquired = tryAcquireDaemonLock();
    expect(acquired.kind).toBe('acquired');
    if (acquired.kind !== 'acquired') throw new Error('expected the fresh server lock');
    expect(acquired.pidPath).toBe(path.join(stateDir, 'server.pid'));
    const onDisk = JSON.parse(fs.readFileSync(acquired.pidPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(['pid', 'socketPath', 'startedAt', 'stateDir', 'stateId', 'version']);
    expect(decodeServerLock(encodeServerLock(acquired.info))).toEqual(acquired.info);
    expect(onDisk).toEqual({
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath: getServerSocketPath(),
      startedAt: expect.any(Number),
      stateDir,
      stateId: getStateDirIdentity(),
    });
    expect(getStateDirIdentity()).not.toBeNull();
  });
});
