/**
 * Machine-server support on socket-incapable filesystems — issue #997 (and the
 * adjacent #974 WSL2 DrvFs hazard).
 *
 * A state directory on an ExFAT/FAT external volume (or some network mounts /
 * WSL2 DrvFs) breaks the server at TWO points, BOTH surfacing as ENOTSUP
 * (verified on a real macOS fskit ExFAT volume):
 *
 *   1. Lock acquisition `link()`s a temp file onto `<state>/server.pid` for
 *      race-free exclusivity (#411). ExFAT has no hard links, so this throws
 *      first — before the socket is ever reached. The fix falls back to an
 *      O_EXCL create (`acquireLockViaExclusiveOpen`).
 *   2. The socket `listen()` then throws ENOTSUP regardless of path length, so
 *      a length-only tmpdir fallback never triggers. The fix makes the socket
 *      path an ORDERED candidate list (in the state dir, then a deterministic
 *      tmpdir path); the server binds the first that works and the proxy
 *      connects the first that answers, so both converge on the fallback with
 *      zero coordination.
 *
 * Both failures report a DIFFERENT errno per OS — ENOTSUP (macOS), EPERM (Linux),
 * EISDIR (Windows) — so the fix deliberately does NOT gate on an enumerated set:
 * the lock falls back on ANY non-EEXIST link error, the socket relocates on ANY
 * non-EADDRINUSE bind error. These tests pin that policy (incl. a deliberately
 * unanticipated errno), the candidate list, the candidate-walk binder, and the
 * exclusive-open lock primitive. (Throwaway scripts drove the full server end-to-
 * end on a real macOS ExFAT image, a Linux FAT loopback mount, and a Windows
 * exFAT VHD — relocate, serve a real client, rewrite the pidfile — none of which
 * can run in CI.)
 *
 * Every case that reads the state dir points CODEGRAPH_STATE_DIR at a temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../src/directory';
import { getStateDirIdentity } from '../src/extensions/host/server/state-dir';
import {
  decodeServerLock,
  getServerPidPath,
  getServerSocketCandidates,
  getServerSocketPath,
} from '../src/mcp/daemon-paths';
import type { ServerLockInfo } from '../src/mcp/daemon-paths';
import {
  acquireLockViaExclusiveOpen,
  bindFirstUsableSocket,
  clearStaleDaemonLock,
  tryAcquireDaemonLock,
} from '../src/mcp/daemon';

const POSIX = process.platform !== 'win32';

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];
const priorStateDir = process.env.CODEGRAPH_STATE_DIR;

/** Point the state dir at a fresh temp dir for this case. */
function useStateDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-state-')));
  tmpDirs.push(dir);
  process.env.CODEGRAPH_STATE_DIR = dir;
  return dir;
}

beforeEach(() => { delete process.env.CODEGRAPH_STATE_DIR; });
afterEach(() => {
  if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
  while (tmpFiles.length) {
    try { fs.rmSync(tmpFiles.pop()!, { force: true }); } catch { /* best-effort */ }
  }
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** A stand-in net.Server — bindFirstUsableSocket only ever passes it through. */
const fakeServer = (tag: string): net.Server => ({ tag } as unknown as net.Server);

/** Build an ErrnoException carrying a specific code, like a real listen() error. */
function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`listen ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/**
 * Make `state` exist and point the state dir at it: the candidate list is keyed
 * on the directory's identity, so it is empty until the directory exists.
 */
function useExistingStateDir(state: string): void {
  fs.mkdirSync(state, { recursive: true });
  tmpDirs.push(state);
  process.env.CODEGRAPH_STATE_DIR = state;
}

describe('getServerSocketCandidates (#997)', () => {
  it('is empty while the state dir does not exist (no identity, nothing to find)', () => {
    process.env.CODEGRAPH_STATE_DIR = path.join(os.tmpdir(), `cg-cand-missing-${process.pid}-${Date.now()}`);
    expect(getServerSocketCandidates()).toEqual([]);
    expect(() => getServerSocketPath()).toThrow(/does not exist/);
  });

  it.runIf(POSIX)('returns [state dir, tmpdir] for a normal short path', () => {
    const state = path.join(os.tmpdir(), 'cg-cand-short');
    useExistingStateDir(state);
    const candidates = getServerSocketCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(path.join(state, 'server.sock'));
    expect(candidates[1]!.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(candidates[1]!)).toMatch(/^codegraph-server-[0-9a-f]{16}\.sock$/);
  });

  it.runIf(POSIX)('drops straight to [tmpdir] when the state-dir path is too long', () => {
    // A deep state dir pushes `server.sock` past the POSIX socket limit.
    useExistingStateDir(path.join('/tmp', 'x'.repeat(120)));
    const candidates = getServerSocketCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startsWith(os.tmpdir())).toBe(true);
  });

  it.runIf(POSIX)('is deterministic and state-dir-scoped: same dir → same tmpdir fallback', () => {
    const state = path.join(os.tmpdir(), 'cg-cand-determinism');
    useExistingStateDir(state);
    const a = getServerSocketCandidates();
    const b = getServerSocketCandidates();
    expect(a).toEqual(b);
    // A different state dir (a development build beside the live server) yields
    // a different (hashed) tmpdir fallback, so two servers never share a socket.
    useExistingStateDir(state + '-other');
    const other = getServerSocketCandidates();
    expect(other[other.length - 1]).not.toBe(a[a.length - 1]);
  });

  it.runIf(!POSIX)('returns a single named pipe on Windows', () => {
    useExistingStateDir(path.join(os.tmpdir(), 'cg-cand-pipe'));
    const candidates = getServerSocketCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startsWith('\\\\.\\pipe\\codegraph-server-')).toBe(true);
  });

  it('getServerSocketPath returns the preferred candidate (index 0)', () => {
    useExistingStateDir(path.join(os.tmpdir(), 'cg-cand-primary'));
    expect(getServerSocketPath()).toBe(getServerSocketCandidates()[0]);
  });
});

describe('bindFirstUsableSocket (#997)', () => {
  it('binds the first candidate when it works, without relocating', async () => {
    const tried: string[] = [];
    const relocations: string[] = [];
    const result = await bindFirstUsableSocket(
      ['/state/server.sock', '/tmp/fallback.sock'],
      (p) => { tried.push(p); return Promise.resolve(fakeServer(p)); },
      { onRelocate: (from, to) => relocations.push(`${from}->${to}`) },
    );
    expect(result.socketPath).toBe('/state/server.sock');
    expect(tried).toEqual(['/state/server.sock']); // never touched the fallback
    expect(relocations).toEqual([]);
  });

  it('relocates to the tmpdir fallback when the state-dir bind throws ENOTSUP', async () => {
    const tried: string[] = [];
    const relocations: Array<[string, string, string]> = [];
    const result = await bindFirstUsableSocket(
      ['/exfat/state/server.sock', '/tmp/fallback.sock'],
      (p) => {
        tried.push(p);
        if (p.includes('/exfat/')) return Promise.reject(errno('ENOTSUP'));
        return Promise.resolve(fakeServer(p));
      },
      { onRelocate: (from, to, code) => relocations.push([from, to, code]) },
    );
    expect(result.socketPath).toBe('/tmp/fallback.sock');
    expect(tried).toEqual(['/exfat/state/server.sock', '/tmp/fallback.sock']);
    expect(relocations).toEqual([
      ['/exfat/state/server.sock', '/tmp/fallback.sock', 'ENOTSUP'],
    ]);
  });

  it('does NOT relocate on EADDRINUSE — it propagates even with a fallback present', async () => {
    const tried: string[] = [];
    await expect(
      bindFirstUsableSocket(
        ['/state/server.sock', '/tmp/fallback.sock'],
        (p) => { tried.push(p); return Promise.reject(errno('EADDRINUSE')); },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(tried).toEqual(['/state/server.sock']); // fallback never tried
  });

  it('propagates a capability error on the LAST candidate (nowhere left to go)', async () => {
    // When tmpdir itself can't host a socket, the single-candidate long-path list
    // (or the exhausted tail of a longer one) has no fallback — the server must
    // surface the error so the launcher serves in-process (#974).
    await expect(
      bindFirstUsableSocket(
        ['/tmp/only.sock'],
        () => Promise.reject(errno('ENOTSUP')),
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' });
  });

  it('walks past multiple unusable candidates to the first that binds', async () => {
    const tried: string[] = [];
    const result = await bindFirstUsableSocket(
      ['/a.sock', '/b.sock', '/c.sock'],
      (p) => {
        tried.push(p);
        if (p === '/a.sock') return Promise.reject(errno('ENOTSUP'));
        if (p === '/b.sock') return Promise.reject(errno('EACCES'));
        return Promise.resolve(fakeServer(p));
      },
    );
    expect(result.socketPath).toBe('/c.sock');
    expect(tried).toEqual(['/a.sock', '/b.sock', '/c.sock']);
  });

  it('relocates on an UNEXPECTED errno too — the policy is "anything but EADDRINUSE", not a fixed list', async () => {
    // ExFAT/FAT report different bind errnos per OS (ENOTSUP macOS, EPERM Linux),
    // so we must NOT gate relocation on an enumerated set — a code we never
    // anticipated must still fall through to tmpdir. 'EWEIRD' stands in for any
    // such surprise.
    const result = await bindFirstUsableSocket(
      ['/odd/state/server.sock', '/tmp/fallback.sock'],
      (p) => p.includes('/odd/') ? Promise.reject(errno('EWEIRD')) : Promise.resolve(fakeServer(p)),
    );
    expect(result.socketPath).toBe('/tmp/fallback.sock');
  });
});

describe('lock acquisition without hard links (#997)', () => {
  // The hard-link-FAILS path (link() → O_EXCL fallback) can't be forced on a
  // normal FS — fs.linkSync's namespace export is non-configurable, so it can't
  // be spied. It's proven instead end-to-end on real ExFAT/FAT/exFAT volumes
  // (macOS ENOTSUP, Linux EPERM, Windows EISDIR — all acquire via the fallback).
  // Here we just guard that the refactored catch block didn't break the normal
  // link path: a clean acquire, and a second caller correctly sees it held.
  it.runIf(POSIX)('tryAcquireDaemonLock still acquires on a normal FS, and a second caller is told it is taken', () => {
    const state = useStateDir();

    const first = tryAcquireDaemonLock();
    expect(first.kind).toBe('acquired');
    const pidPath = getServerPidPath();
    expect(pidPath).toBe(path.join(state, 'server.pid'));
    expect(fs.existsSync(pidPath)).toBe(true);
    const record = decodeServerLock(fs.readFileSync(pidPath, 'utf8'));
    expect(record?.pid).toBe(process.pid);
    expect(record?.stateDir).toBe(state);
    expect(record?.stateId).toBe(getStateDirIdentity());
    expect(record?.stateId).toBe(statInode(state));

    const second = tryAcquireDaemonLock(); // link() → EEXIST → taken
    expect(second.kind).toBe('taken');
    if (second.kind === 'taken') expect(second.existing?.pid).toBe(process.pid);
  });

  it.runIf(POSIX)('creates a missing state dir (mode 0700) for the first server on a machine', () => {
    const parent = useStateDir();
    process.env.CODEGRAPH_STATE_DIR = path.join(parent, 'fresh', 'state');
    expect(tryAcquireDaemonLock().kind).toBe('acquired');
    expect(fs.statSync(path.join(parent, 'fresh', 'state')).mode & 0o777).toBe(0o700);
  });

  it.runIf(POSIX)('acquireLockViaExclusiveOpen creates the pidfile with a complete, parseable record', () => {
    const pidPath = path.join(os.tmpdir(), `cg-excl-${process.pid}-${Date.now()}.pid`);
    tmpFiles.push(pidPath);
    const info: ServerLockInfo = {
      pid: 4242,
      version: '9.9.9-test',
      socketPath: '/tmp/whatever.sock',
      startedAt: 1_700_000_000_000,
      stateDir: '/tmp/state',
      stateId: '16777234:99',
    };

    const acquired = acquireLockViaExclusiveOpen(pidPath, info);
    expect(acquired).toBe(true);
    // The file is non-empty and decodes back to exactly what we wrote — i.e. no
    // empty-file window left behind for a reader to mistake for a corrupt lock.
    expect(decodeServerLock(fs.readFileSync(pidPath, 'utf8'))).toEqual(info);
  });

  it.runIf(POSIX)('acquireLockViaExclusiveOpen is exclusive: the second caller loses (EEXIST → false)', () => {
    const pidPath = path.join(os.tmpdir(), `cg-excl2-${process.pid}-${Date.now()}.pid`);
    tmpFiles.push(pidPath);
    const winner: ServerLockInfo = { pid: 1, version: 'a', socketPath: '/s1', startedAt: 1, stateDir: '/state', stateId: '1:2' };
    const loser: ServerLockInfo = { pid: 2, version: 'b', socketPath: '/s2', startedAt: 2, stateDir: '/state', stateId: '1:2' };

    expect(acquireLockViaExclusiveOpen(pidPath, winner)).toBe(true);
    expect(acquireLockViaExclusiveOpen(pidPath, loser)).toBe(false); // does not clobber
    // The winner's record is intact — the loser never overwrote it.
    expect(decodeServerLock(fs.readFileSync(pidPath, 'utf8'))).toEqual(winner);
  });
});

describe('server lock decoding', () => {
  it.each(['4242\n', '1e3', '{"pid":1}', ''])('reads %j as no record (a plain pid or an incomplete record is not a server lock)', (raw) => {
    expect(decodeServerLock(raw)).toBeNull();
  });

  it('keeps exactly the six record fields', () => {
    const record = { pid: 7, version: '1.0.0', socketPath: '/s', startedAt: 3, stateDir: '/state', stateId: '1:2' };
    expect(decodeServerLock(JSON.stringify({ ...record, root: '/old/project-stamp' }))).toEqual(record);
  });
});

describe('stale server lock snapshot validation', () => {
  it('does not delete a same-PID replacement whose identity was never probed', () => {
    const pidPath = path.join(os.tmpdir(), `cg-snapshot-${process.pid}-${Date.now()}.pid`);
    tmpFiles.push(pidPath);
    const original = JSON.stringify({
      pid: process.pid,
      version: '1.5.0',
      socketPath: '/old.sock',
      startedAt: 1,
      stateDir: '/state',
      stateId: '1:2',
    });
    const replacement = JSON.stringify({
      pid: process.pid,
      version: '1.5.0',
      socketPath: '/new.sock',
      startedAt: 2,
      stateDir: '/state',
      stateId: '1:2',
    });
    fs.writeFileSync(pidPath, replacement);

    expect(clearStaleDaemonLock(pidPath, process.pid, {
      allowLivePid: true,
      expectedLockContents: original,
    })).toBe(false);
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(replacement);
  });
});
