/**
 * The machine server's state dir and the paths and lock record keyed on it.
 *
 * src/extensions/host/server/state-dir.ts: `getStateDir()` is
 * `CODEGRAPH_STATE_DIR` when set (absolute only), else `~/.codegraph`, read on
 * every call, creating nothing; `ensureStateDir()` makes it mode 0700.
 * src/mcp/daemon-paths.ts: the server's socket candidates, pid and log paths
 * all derive from it, and the lock record carries no project root.
 * `getStateDirIdentity()` is what the lock and the tmpdir socket / pipe names are
 * keyed on: one physical directory is one identity whatever its spelling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../src/directory';
import { ensureStateDir, getStateDir, getStateDirIdentity, InvalidStateDirError } from '../../../src/extensions/host/server/state-dir';
import { installFirmlinkAlias } from './firmlink-alias';
import {
  decodeServerLock,
  encodeServerLock,
  getServerLogPath,
  getServerPidPath,
  getServerSocketCandidates,
  getServerSocketPath,
  type ServerLockInfo,
} from '../../../src/mcp/daemon-paths';

let savedStateDir: string | undefined;
let tempDir: string;

beforeEach(() => {
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  delete process.env.CODEGRAPH_STATE_DIR;
  // Realpath'd: the state dir is canonical, and /tmp is a symlink on macOS (to /private/tmp).
  // Not os.tmpdir(): the in-state socket candidate (`<state dir>/server.sock`) is dropped past 100
  // characters, so a long TMPDIR would change what these tests see. Windows has no /tmp, so it keeps
  // os.tmpdir().
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cg-state-dir-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('getStateDir', () => {
  it('is ~/.codegraph when CODEGRAPH_STATE_DIR is unset or empty', () => {
    expect(getStateDir()).toBe(path.join(os.homedir(), '.codegraph'));
    process.env.CODEGRAPH_STATE_DIR = '';
    expect(getStateDir()).toBe(path.join(os.homedir(), '.codegraph'));
  });

  it('is the absolute CODEGRAPH_STATE_DIR, normalised', () => {
    process.env.CODEGRAPH_STATE_DIR = tempDir;
    expect(getStateDir()).toBe(tempDir);
    process.env.CODEGRAPH_STATE_DIR = tempDir + path.sep;
    expect(getStateDir()).toBe(tempDir);
    process.env.CODEGRAPH_STATE_DIR = path.join(tempDir, 'a', '..', 'b');
    expect(getStateDir()).toBe(path.join(tempDir, 'b'));
  });

  it('refuses a relative CODEGRAPH_STATE_DIR, never resolving it against the working directory', () => {
    for (const relative of ['state', './state', '../state', 'a/b']) {
      process.env.CODEGRAPH_STATE_DIR = relative;
      expect(() => getStateDir()).toThrow(InvalidStateDirError);
      expect(() => getStateDir()).toThrow(/absolute path/);
    }
  });

  it('is read on every call, never cached', () => {
    process.env.CODEGRAPH_STATE_DIR = path.join(tempDir, 'one');
    expect(getStateDir()).toBe(path.join(tempDir, 'one'));
    process.env.CODEGRAPH_STATE_DIR = path.join(tempDir, 'two');
    expect(getStateDir()).toBe(path.join(tempDir, 'two'));
  });

  it('creates nothing', () => {
    const state = path.join(tempDir, 'not-yet');
    process.env.CODEGRAPH_STATE_DIR = state;
    getStateDir();
    expect(fs.existsSync(state)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('one physical state dir has one spelling (symlink aliases)', () => {
  let real: string;
  let alias: string;

  beforeEach(() => {
    real = path.join(tempDir, 'real');
    alias = path.join(tempDir, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, 'dir');
  });

  it('gives the alias and the real path the same getStateDir()', () => {
    process.env.CODEGRAPH_STATE_DIR = real;
    const viaReal = getStateDir();
    process.env.CODEGRAPH_STATE_DIR = alias;
    expect(getStateDir()).toBe(viaReal);
    expect(viaReal).toBe(real);
    process.env.CODEGRAPH_STATE_DIR = alias + path.sep;
    expect(getStateDir()).toBe(real);
  });

  it('gives them the same socket candidates, pid path and log path', () => {
    process.env.CODEGRAPH_STATE_DIR = real;
    const viaReal = { sockets: getServerSocketCandidates(), pid: getServerPidPath(), log: getServerLogPath() };
    process.env.CODEGRAPH_STATE_DIR = alias;
    expect({ sockets: getServerSocketCandidates(), pid: getServerPidPath(), log: getServerLogPath() }).toEqual(viaReal);
  });

  it('canonicalizes a state dir that does not exist yet through its existing ancestor, and keeps that spelling once created', () => {
    process.env.CODEGRAPH_STATE_DIR = path.join(alias, 'new', 'state');
    const before = getStateDir();
    expect(before).toBe(path.join(real, 'new', 'state'));
    expect(ensureStateDir()).toBe(before);
    expect(getStateDir()).toBe(before);
    expect(fs.statSync(before).isDirectory()).toBe(true);
  });

  it('canonicalizes a symlinked leaf created after the first read', () => {
    const leaf = path.join(tempDir, 'leaf');
    process.env.CODEGRAPH_STATE_DIR = leaf;
    expect(getStateDir()).toBe(leaf);
    fs.symlinkSync(real, leaf, 'dir');
    expect(getStateDir()).toBe(real);
  });
});

describe('getStateDirIdentity', () => {
  it('is null while the state dir does not exist, then the directory\'s identity once it does', () => {
    const state = path.join(tempDir, 'later');
    process.env.CODEGRAPH_STATE_DIR = state;
    expect(getStateDirIdentity()).toBeNull();
    ensureStateDir();
    expect(getStateDirIdentity()).not.toBeNull();
    if (process.platform !== 'win32') expect(getStateDirIdentity()).toBe(statInode(state));
  });

  it('tells two state dirs apart', () => {
    const a = path.join(tempDir, 'a');
    const b = path.join(tempDir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    process.env.CODEGRAPH_STATE_DIR = a;
    const idA = getStateDirIdentity();
    process.env.CODEGRAPH_STATE_DIR = b;
    expect(getStateDirIdentity()).not.toBe(idA);
  });

  it('throws for a relative CODEGRAPH_STATE_DIR like getStateDir', () => {
    process.env.CODEGRAPH_STATE_DIR = 'relative-state';
    expect(() => getStateDirIdentity()).toThrow(InvalidStateDirError);
  });
});

describe.runIf(process.platform !== 'win32')(
  'two spellings of one physical state dir that realpath keeps apart (a macOS firmlink)',
  () => {
    let real: string;
    let alias: string;

    beforeEach(() => {
      real = path.join(tempDir, 'real');
      alias = path.join(tempDir, 'alias');
      fs.mkdirSync(real);
      installFirmlinkAlias(real, alias);
    });

    it('premise: getStateDir() spells them two ways, the directory is one', () => {
      process.env.CODEGRAPH_STATE_DIR = real;
      const viaReal = getStateDir();
      process.env.CODEGRAPH_STATE_DIR = alias;
      const viaAlias = getStateDir();
      expect(viaReal).toBe(real);
      expect(viaAlias).toBe(alias);
      expect(statInode(viaAlias)).toBe(statInode(viaReal));
    });

    it('gives both the same identity', () => {
      process.env.CODEGRAPH_STATE_DIR = real;
      const viaReal = getStateDirIdentity();
      process.env.CODEGRAPH_STATE_DIR = alias;
      expect(viaReal).not.toBeNull();
      expect(getStateDirIdentity()).toBe(viaReal);
    });

    it('gives both the same tmpdir fallback socket and the same list shape', () => {
      process.env.CODEGRAPH_STATE_DIR = real;
      const viaReal = getServerSocketCandidates();
      process.env.CODEGRAPH_STATE_DIR = alias;
      const viaAlias = getServerSocketCandidates();
      expect(viaAlias).toHaveLength(viaReal.length);
      expect(viaAlias).toHaveLength(2);
      // The fallback is keyed on the identity: one name for both spellings.
      expect(viaAlias.at(-1)).toBe(viaReal.at(-1));
      // The state-dir candidate is the directory's own server.sock, spelled as the caller reaches the directory.
      expect(viaReal[0]).toBe(path.join(real, 'server.sock'));
      expect(viaAlias[0]).toBe(path.join(alias, 'server.sock'));
      expect(statInode(path.dirname(viaAlias[0]!))).toBe(statInode(path.dirname(viaReal[0]!)));
    });

    it('gives both the same tmpdir fallback when the state-dir candidate is dropped for length', () => {
      // The fallback is never dropped, and it is one file whichever spelling a launcher reaches the directory by.
      const longReal = path.join(real, 'y'.repeat(120));
      const longAlias = path.join(alias, 'y'.repeat(120));
      fs.mkdirSync(longReal);
      process.env.CODEGRAPH_STATE_DIR = longReal;
      const viaReal = getServerSocketCandidates();
      process.env.CODEGRAPH_STATE_DIR = longAlias;
      expect(getServerSocketCandidates()).toEqual(viaReal);
      expect(viaReal).toHaveLength(1);
      expect(viaReal[0]!.startsWith(os.tmpdir())).toBe(true);
    });

    it('gives both the same pid and log file', () => {
      process.env.CODEGRAPH_STATE_DIR = real;
      const pidViaReal = getServerPidPath();
      process.env.CODEGRAPH_STATE_DIR = alias;
      fs.writeFileSync(pidViaReal, 'x');
      expect(fs.readFileSync(getServerPidPath(), 'utf8')).toBe('x');
      expect(getServerLogPath()).toBe(path.join(alias, 'server.log'));
    });
  },
);

describe('ensureStateDir', () => {
  it('creates the state dir and its missing parents, mode 0700 off Windows, and returns it', () => {
    const state = path.join(tempDir, 'parent', 'state');
    process.env.CODEGRAPH_STATE_DIR = state;
    expect(ensureStateDir()).toBe(state);
    expect(fs.statSync(state).isDirectory()).toBe(true);
    // Mode bits are the umask's to narrow, never widen: 0700 survives any umask.
    if (process.platform !== 'win32') expect(fs.statSync(state).mode & 0o777).toBe(0o700);
  });

  it('is idempotent and leaves an existing directory\'s contents and mode alone', () => {
    const state = path.join(tempDir, 'state');
    process.env.CODEGRAPH_STATE_DIR = state;
    ensureStateDir();
    fs.writeFileSync(path.join(state, 'keep'), 'x');
    expect(ensureStateDir()).toBe(state);
    expect(fs.readFileSync(path.join(state, 'keep'), 'utf8')).toBe('x');
  });

  it('throws for a relative CODEGRAPH_STATE_DIR and creates nothing', () => {
    process.env.CODEGRAPH_STATE_DIR = 'relative-state';
    expect(() => ensureStateDir()).toThrow(InvalidStateDirError);
    expect(fs.existsSync(path.resolve('relative-state'))).toBe(false);
  });
});

describe('server paths follow the state dir', () => {
  it('puts the pid and log in the state dir and the first socket candidate there', () => {
    process.env.CODEGRAPH_STATE_DIR = tempDir;
    expect(getServerPidPath()).toBe(path.join(tempDir, 'server.pid'));
    expect(getServerLogPath()).toBe(path.join(tempDir, 'server.log'));
    if (process.platform !== 'win32') {
      expect(getServerSocketPath()).toBe(path.join(tempDir, 'server.sock'));
      const candidates = getServerSocketCandidates();
      expect(candidates).toHaveLength(2);
      expect(candidates[1]!.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(candidates[1]!)).toMatch(/^codegraph-server-[0-9a-f]{16}\.sock$/);
    }
  });

  it('gives two state dirs different fallback sockets, and one state dir the same one every time', () => {
    const a = path.join(tempDir, 'a');
    const b = path.join(tempDir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    process.env.CODEGRAPH_STATE_DIR = a;
    const first = getServerSocketCandidates();
    expect(getServerSocketCandidates()).toEqual(first);
    process.env.CODEGRAPH_STATE_DIR = b;
    const second = getServerSocketCandidates();
    // Whatever the platform's last candidate is (tmpdir socket, Windows pipe), it is keyed on the state dir.
    expect(second.at(-1)).not.toBe(first.at(-1));
    expect(second[0]).not.toBe(first[0]);
  });

  it.runIf(process.platform !== 'win32')('drops the in-state-dir socket when its path is too long for AF_UNIX', () => {
    const deep = path.join(tempDir, 'x'.repeat(120));
    fs.mkdirSync(deep);
    process.env.CODEGRAPH_STATE_DIR = deep;
    const candidates = getServerSocketCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.startsWith(os.tmpdir())).toBe(true);
    // The pid file has no length limit: it stays in the state dir.
    expect(getServerPidPath()).toBe(path.join(deep, 'server.pid'));
  });
});

describe('server lock record', () => {
  const info: ServerLockInfo = {
    pid: 4242,
    version: '1.2.3',
    socketPath: '/tmp/x.sock',
    startedAt: 1_700_000_000_000,
    stateDir: '/state',
    stateId: '16777234:12345',
  };

  it('round-trips', () => {
    expect(decodeServerLock(encodeServerLock(info))).toEqual(info);
  });

  it('carries no project root or index identity, only the state dir (path and identity)', () => {
    const raw = JSON.parse(encodeServerLock(info)) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['pid', 'socketPath', 'startedAt', 'stateDir', 'stateId', 'version']);
  });

  it('keeps only the six fields when a record carries more', () => {
    const decoded = decodeServerLock(JSON.stringify({ ...info, root: '/old/root', dirId: 'd' }));
    expect(decoded).toEqual(info);
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n'],
    ['garbage', 'not-a-lock'],
    ['a bare pid', '1234\n'],
    ['a record without the state dir', JSON.stringify({ pid: 1, version: 'v', socketPath: 's', startedAt: 1, stateId: '1:2' })],
    ['a record without the state dir identity', JSON.stringify({ pid: 1, version: 'v', socketPath: 's', startedAt: 1, stateDir: '/state' })],
    ['a record with an empty state dir identity', JSON.stringify({ ...info, stateId: '' })],
    ['a record with a numeric state dir identity', JSON.stringify({ ...info, stateId: 7 })],
    ['a record with a string pid', JSON.stringify({ ...info, pid: '4242' })],
    ['JSON null', 'null'],
  ])('decodes %s to null', (_label, raw) => {
    expect(decodeServerLock(raw)).toBeNull();
  });
});
