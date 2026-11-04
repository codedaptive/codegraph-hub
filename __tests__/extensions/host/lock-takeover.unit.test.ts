/**
 * Unit vectors for src/mcp/lock-takeover.ts:
 * compare-and-remove of a lock file under a `${lockPath}.takeover` guard, and
 * the callers' behaviour when the guard is held or the lock cannot be read,
 * and the guard a failed release leaves behind (the next takeover clears it).
 *
 * "Unchanged" means the same bytes AND (off Windows) the same inode and
 * device, so a lock removed and rewritten with identical bytes is a new lock.
 * A guard naming a live pid that is not this process is busy; this test uses
 * process.ppid (the vitest worker's parent, alive for the whole run). A guard
 * naming a dead pid is cleared and the operation proceeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createLockFile,
  removeLockIfUnchanged,
  snapshotLock,
  takeoverGuardHolder,
  withTakeoverGuard,
} from '../../../src/mcp/lock-takeover';
import { getWriterPidPath, markWriterReady, tryAcquireWriterLock } from '../../../src/mcp/writer-lock';
import { refreshDaemonLock, tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import { encodeServerLock, getServerPidPath } from '../../../src/mcp/daemon-paths';
import { FileLock } from '../../../src/utils';

// Writable copies of the builtin namespaces, shared by this file and every src
// module it loads, so vi.spyOn(fs, 'openSync') and vi.spyOn(crypto,
// 'randomBytes') reach the code under test (an ESM namespace of a builtin
// cannot be redefined). Pass-through until a test spies.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));
vi.mock('crypto', async (importOriginal) => ({ ...await importOriginal<typeof import('crypto')>() }));

const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** A pid that was alive a moment ago and is now dead: a just-exited child's. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (typeof r.pid !== 'number' || r.pid <= 0) throw new Error('could not obtain a dead pid');
  return r.pid;
}

let dir: string;
let lock: string;
let guard: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-takeover-'));
  previousStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = dir;
  lock = path.join(dir, 'test.lock');
  guard = `${lock}.takeover`;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = previousStateDir;
  try { fs.chmodSync(lock, 0o600); } catch { /* not there */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Replace `lock` with a new file of the same bytes. The new file exists before the old one is freed, so its inode differs. */
function rewriteSameBytesNewInode(p: string): void {
  const bytes = fs.readFileSync(p);
  const tmp = `${p}.rewrite`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, p);
}

describe('snapshotLock', () => {
  it('returns null when the lock is absent', () => {
    expect(snapshotLock(lock)).toBeNull();
  });

  it.runIf(!isWin)('returns raw, ino and dev when present (POSIX)', () => {
    fs.writeFileSync(lock, '123\n');
    const st = fs.statSync(lock, { bigint: true });
    expect(snapshotLock(lock)).toEqual({ raw: '123\n', ino: st.ino, dev: st.dev });
  });

  it.runIf(isWin)('returns raw with null ino and dev on Windows', () => {
    fs.writeFileSync(lock, '123\n');
    expect(snapshotLock(lock)).toEqual({ raw: '123\n', ino: null, dev: null });
  });
});

describe('removeLockIfUnchanged', () => {
  it("returns 'removed' and deletes the lock when it is the judged file", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    expect(removeLockIfUnchanged(lock, judged)).toBe('removed');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(guard)).toBe(false);
  });

  it("returns 'changed' and keeps the lock when its content differs", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    fs.writeFileSync(lock, '222');
    expect(removeLockIfUnchanged(lock, judged)).toBe('changed');
    expect(fs.readFileSync(lock, 'utf8')).toBe('222');
    expect(fs.existsSync(guard)).toBe(false);
  });

  it.runIf(!isWin)("returns 'changed' for the same bytes in a different inode (POSIX)", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    rewriteSameBytesNewInode(lock);
    expect(fs.statSync(lock, { bigint: true }).ino).not.toBe(judged.ino);
    expect(removeLockIfUnchanged(lock, judged)).toBe('changed');
    expect(fs.readFileSync(lock, 'utf8')).toBe('111');
    expect(fs.existsSync(guard)).toBe(false);
  });

  it("returns 'gone' when the lock is absent", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    fs.unlinkSync(lock);
    expect(removeLockIfUnchanged(lock, judged)).toBe('gone');
    expect(fs.existsSync(guard)).toBe(false);
  });

  it("returns 'busy' and keeps the lock while the guard names another live pid", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    fs.writeFileSync(guard, String(process.ppid));
    expect(removeLockIfUnchanged(lock, judged)).toBe('busy');
    expect(fs.readFileSync(lock, 'utf8')).toBe('111');
    // The guard is the other taker's; it is left exactly as it was.
    expect(fs.readFileSync(guard, 'utf8')).toBe(String(process.ppid));
  });

  it("clears a guard left by a dead pid, then returns 'removed'", () => {
    fs.writeFileSync(lock, '111');
    const judged = snapshotLock(lock)!;
    fs.writeFileSync(guard, String(deadPid()));
    expect(removeLockIfUnchanged(lock, judged)).toBe('removed');
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(guard)).toBe(false);
  });
});

describe('createLockFile', () => {
  it('creates the lock with the body, then refuses (EEXIST) without touching it, leaving no tmp file', () => {
    expect(createLockFile(lock, 'first')).toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toBe('first');
    expect(createLockFile(lock, 'second')).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('first');
    expect(fs.readdirSync(dir)).toEqual([path.basename(lock)]);
  });
});

describe('withTakeoverGuard', () => {
  it('returns busy without running fn while another live pid holds the guard', () => {
    fs.writeFileSync(guard, String(process.ppid));
    let ran = false;
    const r = withTakeoverGuard(lock, () => { ran = true; return 1; });
    expect(r).toEqual({ kind: 'busy' });
    expect(ran).toBe(false);
    expect(fs.readFileSync(guard, 'utf8')).toBe(String(process.ppid));
  });

  it('runs fn holding a guard that names this process, and removes the guard after', () => {
    let seen: string | null = null;
    const r = withTakeoverGuard(lock, () => {
      seen = fs.readFileSync(guard, 'utf8').trim();
      return 42;
    });
    expect(r).toEqual({ kind: 'ran', value: 42 });
    expect(seen).toBe(String(process.pid));
    expect(fs.existsSync(guard)).toBe(false);
  });

  it('removes the guard when fn throws', () => {
    expect(() => withTakeoverGuard(lock, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(guard)).toBe(false);
  });

  it.runIf(!isWin && !isRoot)(
    'a guard whose release failed is this pid\'s leftover: not busy, and the next takeover clears it (POSIX, non-root)',
    () => {
      // A read-only directory makes releaseGuard's unlink fail with EACCES, which it swallows: the guard stays,
      // naming this pid. The directory is writable again before the next takeover needs it.
      let outcome: unknown;
      try {
        outcome = withTakeoverGuard(lock, () => { fs.chmodSync(dir, 0o555); return 'ran'; });
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      expect(outcome).toEqual({ kind: 'ran', value: 'ran' });
      expect(fs.readFileSync(guard, 'utf8')).toBe(String(process.pid));
      expect(takeoverGuardHolder(lock)).toBeUndefined();

      // A stale lock judged from one snapshot is removed: the own-pid leftover is cleared, the guard is taken,
      // the lock is unlinked and the guard released.
      fs.writeFileSync(lock, String(deadPid()));
      const judged = snapshotLock(lock)!;
      expect(removeLockIfUnchanged(lock, judged)).toBe('removed');
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(guard)).toBe(false);
    },
  );
});

describe('callers honour the guard and fail closed', () => {
  it('tryAcquireWriterLock on a stale lock whose guard a live pid holds returns taken and leaves the record', () => {
    const root = path.join(dir, 'proj');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    const pidPath = getWriterPidPath(root);
    const record = JSON.stringify({ pid: deadPid(), mode: 'fallback', startedAt: 1 });
    fs.writeFileSync(pidPath, record);
    fs.writeFileSync(`${pidPath}.takeover`, String(process.ppid));

    const r = tryAcquireWriterLock(root, 'fallback');
    expect(r.kind).toBe('taken');
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(record);
  });

  it('FileLock on a lock path that cannot be read (a directory) throws "locked" and leaves it in place', () => {
    fs.mkdirSync(lock);
    expect(() => new FileLock(lock).acquire()).toThrow(/locked/);
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  it.runIf(!isWin && !isRoot)('FileLock on an unreadable lock file (mode 000) throws "locked" and leaves it in place (POSIX, non-root)', () => {
    fs.writeFileSync(lock, '999999');
    fs.chmodSync(lock, 0o000);
    expect(() => new FileLock(lock).acquire()).toThrow(/locked/);
    expect(fs.existsSync(lock)).toBe(true);
  });
});

/**
 * Every temp write on a lock file goes through writeExclusiveTemp: a fresh
 * random name per call (`${lockPath}.${pid}.<12 hex>.tmp`), opened 'wx', and an
 * existing entry is never removed (it may be a sibling thread's temp file, and
 * worker threads share a pid). Nothing planted beside a lock can redirect the
 * write.
 *
 * Each case plants symlinks to a victim file at the predictable names earlier
 * code used (`.${pid}.tmp`, `.replace.tmp`, `.ready.tmp`, `.bound`), and at
 * the name a forced crypto.randomBytes draws first. randomBytes is mocked to
 * alternate forced, real, forced, real, so every temp write first meets a
 * planted symlink and must draw a new name. fs.openSync is spied to show the
 * planted name was opened 'wx' (and refused) and every temp open was 'wx'.
 * Afterwards: the victim is unchanged, every planted link is still there, the
 * lock is a regular file with the expected body, and no temp of ours is left.
 * POSIX only: creating a file symlink on Windows needs Developer Mode.
 */
describe.runIf(!isWin)('lock temp files: random name, exclusive create, never followed or deleted (POSIX)', () => {
  const VICTIM_BODY = 'victim: must stay unchanged';
  const FORCED_HEX = 'f0f0f0f0f0f0';
  let victimDir: string;
  let victim: string;
  let planted: string[];
  let opens: Array<{ path: string; flags: unknown }>;

  beforeEach(() => {
    victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lock-victim-'));
    victim = path.join(victimDir, 'victim.txt');
    fs.writeFileSync(victim, VICTIM_BODY);
    planted = [];
    opens = [];
    const realOpen = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      opens.push({ path: String(p), flags });
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(victimDir, { recursive: true, force: true });
  });

  /** `${base}.${pid}.${FORCED_HEX}.tmp`: the name writeExclusiveTemp draws when randomBytes returns the forced bytes. */
  function forcedName(base: string): string {
    return `${base}.${process.pid}.${FORCED_HEX}.tmp`;
  }

  /** Plant victim symlinks at the old predictable names and the forced name beside `base`. */
  function plantBeside(base: string): void {
    const pid = process.pid;
    for (const p of [`${base}.${pid}.tmp`, `${base}.${pid}.replace.tmp`, `${base}.${pid}.ready.tmp`, `${base}.${pid}.bound`, forcedName(base)]) {
      fs.symlinkSync(victim, p);
      planted.push(p);
    }
  }

  /** randomBytes alternates forced, real, forced, real, ... (`always` = forced every time). */
  function forceRandomNames(always = false) {
    const real = crypto.randomBytes;
    let n = 0;
    return vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) =>
      (always || n++ % 2 === 0 ? Buffer.from(FORCED_HEX, 'hex') : real(size))) as unknown as typeof crypto.randomBytes);
  }

  /**
   * The forced name beside `base` was opened, with 'wx' (the planted link
   * there survives, so the open was refused), and every temp open beside
   * `base` was 'wx'.
   */
  function expectExclusiveTempOpens(base: string): void {
    const tempOpens = opens.filter((o) => o.path.startsWith(`${base}.`) && o.path.endsWith('.tmp'));
    expect(tempOpens.some((o) => o.path === forcedName(base))).toBe(true);
    expect(tempOpens.length).toBeGreaterThan(0);
    for (const o of tempOpens) expect(o.flags).toBe('wx');
  }

  /** Victim unchanged, every planted link still a link, no temp of ours left in `dirPath`. */
  function expectNothingFollowedOrLeft(dirPath: string): void {
    expect(fs.readFileSync(victim, 'utf8')).toBe(VICTIM_BODY);
    for (const p of planted) expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
    const plantedNames = new Set(planted.map((p) => path.basename(p)));
    const ours = fs.readdirSync(dirPath).filter((f) => (f.endsWith('.tmp') || f.endsWith('.bound')) && !plantedNames.has(f));
    expect(ours).toEqual([]);
  }

  it('createLockFile: draws a new name past a planted one; the lock is a regular file with the body', () => {
    plantBeside(lock);
    forceRandomNames();

    expect(createLockFile(lock, 'x')).toBe(true);

    expectNothingFollowedOrLeft(dir);
    expect(fs.lstatSync(lock).isFile()).toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toBe('x');
    expectExclusiveTempOpens(lock);
  });

  it('withTakeoverGuard: the guard draws past planted names, and is removed after', () => {
    plantBeside(guard);
    forceRandomNames();

    expect(withTakeoverGuard(lock, () => 'x')).toEqual({ kind: 'ran', value: 'x' });

    expectNothingFollowedOrLeft(dir);
    expect(fs.existsSync(guard)).toBe(false);
    expectExclusiveTempOpens(guard);
  });

  it('FileLock.acquire on codegraph.lock: the lock holds this pid, nothing planted is touched', () => {
    const lockPath = path.join(dir, 'codegraph.lock');
    plantBeside(lockPath);
    forceRandomNames();

    const fl = new FileLock(lockPath);
    fl.acquire();
    try {
      expectNothingFollowedOrLeft(dir);
      expect(fs.lstatSync(lockPath).isFile()).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
      expectExclusiveTempOpens(lockPath);
    } finally {
      fl.release();
    }
  });

  it('markWriterReady on writer.pid: the ready record replaces the lock, nothing planted is touched', () => {
    const root = path.join(dir, 'proj');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    expect(tryAcquireWriterLock(root, 'fallback').kind).toBe('acquired');
    const pidPath = getWriterPidPath(root);
    plantBeside(pidPath);
    forceRandomNames();

    markWriterReady(root);

    expectNothingFollowedOrLeft(path.dirname(pidPath));
    expect(fs.lstatSync(pidPath).isFile()).toBe(true);
    const rec = JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid: number; ready?: boolean };
    expect(rec.pid).toBe(process.pid);
    expect(rec.ready).toBe(true);
    expectExclusiveTempOpens(pidPath);
  });

  it('tryAcquireDaemonLock then refreshDaemonLock on server.pid: both temps draw past planted names', () => {
    const pidPath = getServerPidPath();
    plantBeside(pidPath);
    forceRandomNames();

    const r = tryAcquireDaemonLock();
    expectNothingFollowedOrLeft(path.dirname(pidPath));
    expect(r.kind).toBe('acquired');
    if (r.kind !== 'acquired') return;
    expect(fs.lstatSync(pidPath).isFile()).toBe(true);
    const initial = fs.readFileSync(pidPath, 'utf8');
    expect(initial).toBe(encodeServerLock(r.info));

    const bound = { ...r.info, socketPath: path.join(dir, 'bound.sock') };
    const forcedOpensBefore = opens.filter((o) => o.path === forcedName(pidPath)).length;
    refreshDaemonLock(pidPath, initial, bound);

    expectNothingFollowedOrLeft(path.dirname(pidPath));
    expect(fs.lstatSync(pidPath).isFile()).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(encodeServerLock(bound));
    expect(opens.filter((o) => o.path === forcedName(pidPath)).length).toBeGreaterThan(forcedOpensBefore);
    expectExclusiveTempOpens(pidPath);
  });

  it('gives up after a bounded number of names, each refused, and touches nothing', () => {
    plantBeside(lock);
    const spy = forceRandomNames(true);

    let code: string | undefined;
    try {
      createLockFile(lock, 'x');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }

    expectNothingFollowedOrLeft(dir);
    expect(code).toBe('EEXIST');
    expect(spy).toHaveBeenCalledTimes(8);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
