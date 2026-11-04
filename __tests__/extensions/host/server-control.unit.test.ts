/**
 * Control of the machine server from outside it: src/mcp/server-control.ts.
 *
 * `stopServer` is exercised against real child processes that bind the state
 * dir's socket and answer the server hello, so the signal, the wait and the
 * sweep are real. A stand-in for the server that proves identity is a node
 * child (below); one that does NOT prove it is a bare `sleep`-like process. The
 * rule under test: a pid is signalled only after its socket hello names the
 * lock's pid and version.
 * `requestProjectRelease` runs against a fake socket server in this process
 * (__tests__/fake-release-server.ts).
 *
 * Every test has its own state dir via CODEGRAPH_STATE_DIR, so nothing here can
 * see the live server of `~/.codegraph`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../src/directory';
import { getStateDir } from '../../../src/extensions/host/server/state-dir';
import { installFirmlinkAlias } from './firmlink-alias';
import { encodeServerLock, getServerPidPath, getServerSocketCandidates, getServerSocketPath, type ServerLockInfo } from '../../../src/mcp/daemon-paths';
import { tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import {
  isProcessAlive,
  namesThisStateDir,
  probeServer,
  readServerLock,
  requestProjectRelease,
  stopServer,
} from '../../../src/mcp/server-control';
import { startFakeServer, type FakeServer } from '../../fake-release-server';

let savedStateDir: string | undefined;
let stateDir: string;
const children: ChildProcess[] = [];
let fake: FakeServer | null = null;

/**
 * A node process that binds `socketPath` and answers every connection with the
 * server hello naming its own pid and `version`; `ignoreTerm` makes it survive
 * SIGTERM. Resolves once it listens.
 */
async function startServerProcess(socketPath: string, version: string, ignoreTerm = false): Promise<ChildProcess> {
  const source = [
    "const net = require('net');",
    'const [sock, version, ignoreTerm] = process.argv.slice(1);',
    "if (ignoreTerm === '1') process.on('SIGTERM', () => {});",
    'const server = net.createServer((c) => {',
    "  c.on('error', () => {});",
    "  c.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath: sock, protocol: 1 }) + '\\n');",
    '});',
    "server.listen(sock, () => console.log('ready'));",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', source, socketPath, version, ignoreTerm ? '1' : '0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('server process exited before listening')));
    child.stdout!.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
  });
  return child;
}

/** A live process that listens on nothing: it can never prove it is the server. */
function startSilentProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/**
 * The identity a server records for `dir`: `dev:ino` off Windows, the
 * lower-cased native realpath on it. Computed here, not by the code under test.
 */
function physicalId(dir: string): string {
  return process.platform === 'win32' ? fs.realpathSync.native(dir).toLowerCase() : statInode(dir)!;
}

function writeLock(info: Partial<ServerLockInfo> & { pid: number }): ServerLockInfo {
  const full: ServerLockInfo = {
    version: '1.0.0',
    socketPath: getServerSocketPath(),
    startedAt: Date.now(),
    stateDir,
    stateId: physicalId(stateDir),
    ...info,
  };
  fs.writeFileSync(getServerPidPath(), encodeServerLock(full));
  return full;
}

async function waitDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isProcessAlive(pid);
}

beforeEach(() => {
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  // Realpath'd: locks record the canonical state dir, and os.tmpdir() is a symlink on some systems (macOS /var).
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-srvctl-')));
  process.env.CODEGRAPH_STATE_DIR = stateDir;
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('isProcessAlive', () => {
  it('is true for this process and false for a non-pid or a dead one', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    for (const bad of [0, -1, NaN, 1.5]) expect(isProcessAlive(bad)).toBe(false);
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((resolve) => child.once('exit', resolve));
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe('readServerLock', () => {
  it('is null with no lock, a corrupt one, or one naming another state dir', () => {
    expect(readServerLock()).toBeNull();
    fs.writeFileSync(getServerPidPath(), 'not-a-lock\n');
    expect(readServerLock()).toBeNull();
    // A state dir copied whole carries the source's lock along: it names the source's state dir.
    writeLock({ pid: process.pid, stateDir: path.join(os.tmpdir(), 'some-other-state-dir'), stateId: 'another-dir:1' });
    expect(readServerLock()).toBeNull();
    // A record without an identity (an older release's) names no state dir to judge it by.
    fs.writeFileSync(getServerPidPath(), JSON.stringify({
      pid: process.pid, version: '1.0.0', socketPath: getServerSocketPath(), startedAt: Date.now(), stateDir,
    }));
    expect(readServerLock()).toBeNull();
  });

  it('judges by identity, not by the stateDir path: a record naming this directory under another path is accepted', () => {
    const written = writeLock({ pid: process.pid, stateDir: '/some/other/spelling/of/it' });
    expect(readServerLock()).toEqual(written);
    expect(namesThisStateDir(written)).toBe(true);
    expect(namesThisStateDir({ ...written, stateId: 'another-dir:1' })).toBe(false);
  });

  it('throws for a relative CODEGRAPH_STATE_DIR instead of reading as no server', async () => {
    process.env.CODEGRAPH_STATE_DIR = 'relative/state';
    expect(() => readServerLock()).toThrow(/absolute path/);
    await expect(probeServer()).rejects.toThrow(/absolute path/);
    await expect(stopServer()).rejects.toThrow(/absolute path/);
  });

  it.runIf(process.platform !== 'win32')('accepts, under a symlink alias of the state dir, a record written under the real path (and the reverse)', async () => {
    const alias = path.join(os.tmpdir(), `cg-srvctl-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(stateDir, alias, 'dir');
    try {
      // The record the server wrote names the canonical state dir.
      const written = writeLock({ pid: process.pid, version: '2.0.0' });
      process.env.CODEGRAPH_STATE_DIR = alias;
      expect(readServerLock()).toEqual(written);
      // And the server answering on the lock's socket verifies the same record under the alias.
      fake = await startFakeServer({ hello: { codegraph: '2.0.0', pid: process.pid, socketPath: written.socketPath, protocol: 1 } });
      expect(await probeServer()).toEqual(written);
      process.env.CODEGRAPH_STATE_DIR = stateDir;
      expect(readServerLock()).toEqual(written);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it('returns the record of this state dir', () => {
    const written = writeLock({ pid: process.pid, version: '3.2.1' });
    expect(readServerLock()).toEqual(written);
  });
});

describe.runIf(process.platform !== 'win32')('one state dir reached by two spellings that realpath keeps apart (a macOS firmlink)', () => {
  let alias: string;

  beforeEach(() => {
    // `stateDir` is the real spelling; `alias` is the other, which realpath leaves as it is.
    alias = path.join(os.tmpdir(), `cg-srvctl-firm-${process.pid}-${Date.now()}`);
    installFirmlinkAlias(stateDir, alias);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(alias, { force: true });
  });

  it('premise: the two spellings are two getStateDir() paths and one directory', () => {
    process.env.CODEGRAPH_STATE_DIR = alias;
    expect(getStateDir()).toBe(alias);
    expect(getStateDir()).not.toBe(stateDir);
    expect(statInode(getStateDir())).toBe(statInode(stateDir));
  });

  it('accepts under each spelling the record the server wrote under the other', async () => {
    process.env.CODEGRAPH_STATE_DIR = alias;
    const writtenViaAlias = writeLock({ pid: process.pid, version: '2.0.0', stateDir: getStateDir() });
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    expect(readServerLock()).toEqual(writtenViaAlias);
    // The server answering on the lock's socket verifies the record under the spelling that did not write it.
    fake = await startFakeServer({ hello: { codegraph: '2.0.0', pid: process.pid, socketPath: writtenViaAlias.socketPath, protocol: 1 } });
    const bound = writeLock({ pid: process.pid, version: '2.0.0', socketPath: fake.socketPath });
    process.env.CODEGRAPH_STATE_DIR = alias;
    expect(readServerLock()).toEqual(bound);
    expect(await probeServer()).toEqual(bound);
  });

  it('never calls the live server\'s lock, read through the other spelling, a copied state dir\'s: launcher check and lock take-over agree', () => {
    process.env.CODEGRAPH_STATE_DIR = alias;
    const first = tryAcquireDaemonLock();
    expect(first.kind).toBe('acquired');
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    const second = tryAcquireDaemonLock();
    expect(second.kind).toBe('taken');
    if (second.kind !== 'taken' || second.existing === null) throw new Error('the live record must be readable');
    // The record is the first server's, written under the spelling this one does not use.
    expect(second.existing.stateDir).toBe(alias);
    expect(getStateDir()).toBe(stateDir);
    // So the launcher's copied-state check sees this state dir's server, and judges the record by identity.
    expect(namesThisStateDir(second.existing)).toBe(true);
    expect(readServerLock()).toEqual(second.existing);
  });

  it('still tells a copy of the state dir from it: another directory is another identity', () => {
    process.env.CODEGRAPH_STATE_DIR = alias;
    const written = writeLock({ pid: process.pid, stateDir: getStateDir() });
    const copy = fs.mkdtempSync(path.join(path.dirname(stateDir), 'cg-srvctl-copy-'));
    try {
      fs.copyFileSync(getServerPidPath(), path.join(copy, 'server.pid'));
      process.env.CODEGRAPH_STATE_DIR = copy;
      expect(namesThisStateDir(written)).toBe(false);
      expect(readServerLock()).toBeNull();
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('probeServer', () => {
  it('returns the lock when the socket hello names its pid and version', async () => {
    fake = await startFakeServer({ hello: { codegraph: '1.0.0', pid: process.pid, socketPath: getServerSocketPath(), protocol: 1 } });
    const written = writeLock({ pid: process.pid, version: '1.0.0', socketPath: fake.socketPath });
    expect(await probeServer()).toEqual(written);
  });

  it('is null when the hello names another pid (a reused pid), another version, or nothing answers', async () => {
    expect(await probeServer()).toBeNull(); // no lock
    writeLock({ pid: process.pid, version: '1.0.0' });
    expect(await probeServer()).toBeNull(); // lock, nothing listening
    fake = await startFakeServer({ hello: { codegraph: '1.0.0', pid: process.pid + 1, socketPath: 's', protocol: 1 } });
    expect(await probeServer()).toBeNull(); // wrong pid
    await fake.close();
    fake = await startFakeServer({ hello: { codegraph: '9.9.9', pid: process.pid, socketPath: 's', protocol: 1 } });
    expect(await probeServer()).toBeNull(); // wrong version
  });
});

describe('probeServer version identity', () => {
  it('matches the version sentinel the version module falls back to, by equality', async () => {
    fake = await startFakeServer({ hello: { codegraph: '0.0.0-unknown', pid: process.pid, socketPath: 's', protocol: 1 } });
    const written = writeLock({ pid: process.pid, version: '0.0.0-unknown', socketPath: fake.socketPath });
    expect(await probeServer()).toEqual(written);
  });

  it('treats no version string as a wildcard: a lock saying "unknown" is verified only by a hello that says so too', async () => {
    fake = await startFakeServer({ hello: { codegraph: '1.0.0', pid: process.pid, socketPath: 's', protocol: 1 } });
    writeLock({ pid: process.pid, version: 'unknown', socketPath: fake.socketPath });
    expect(await probeServer()).toBeNull();
    writeLock({ pid: process.pid, version: '0.0.0-unknown', socketPath: fake.socketPath });
    expect(await probeServer()).toBeNull();
  });
});

describe('stopServer', () => {
  it('is not-running with no lock, a dead pid, or a lock naming another state dir', async () => {
    expect(await stopServer()).toEqual({ outcome: 'not-running' });
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = dead.pid!;
    await new Promise((resolve) => dead.once('exit', resolve));
    writeLock({ pid });
    expect(await stopServer()).toMatchObject({ outcome: 'not-running', pid });
    // The live process this lock names belongs to another state dir's server: never signalled.
    const live = startSilentProcess();
    writeLock({ pid: live.pid!, stateDir: path.join(os.tmpdir(), 'some-other-state-dir'), stateId: 'another-dir:1' });
    expect(await stopServer()).toEqual({ outcome: 'not-running' });
    expect(isProcessAlive(live.pid!)).toBe(true);
  });

  it('refuses to signal a live pid whose socket does not prove it is the server (unverified)', async () => {
    const stranger = startSilentProcess();
    const written = writeLock({ pid: stranger.pid!, socketPath: path.join(stateDir, 'nothing-listens.sock') });
    const result = await stopServer({ graceMs: 200 });
    expect(result).toEqual({ outcome: 'unverified', pid: stranger.pid, version: written.version });
    // Not signalled, and its lock is left as found.
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(stranger.pid!)).toBe(true);
    expect(stranger.signalCode).toBeNull();
    expect(readServerLock()).toEqual(written);
  });

  it('refuses to signal a pid whose hello names a different pid (a reused pid answering on the socket)', async () => {
    const stranger = startSilentProcess();
    fake = await startFakeServer({ hello: { codegraph: '1.0.0', pid: stranger.pid! + 1, socketPath: 's', protocol: 1 } });
    writeLock({ pid: stranger.pid!, socketPath: fake.socketPath });
    expect((await stopServer({ graceMs: 200 })).outcome).toBe('unverified');
    expect(isProcessAlive(stranger.pid!)).toBe(true);
    expect(stranger.signalCode).toBeNull();
  });

  it('SIGTERMs a verified server, waits for it to exit and sweeps its lock and socket', async () => {
    const server = await startServerProcess(getServerSocketPath(), '1.0.0');
    writeLock({ pid: server.pid!, version: '1.0.0' });
    const result = await stopServer({ graceMs: 5_000 });
    expect(result).toEqual({ outcome: 'stopped', pid: server.pid, version: '1.0.0' });
    expect(await waitDead(server.pid!)).toBe(true);
    expect(server.signalCode).toBe('SIGTERM');
    // The child could not remove its own files on a hard SIGTERM; the sweep did.
    expect(fs.existsSync(getServerPidPath())).toBe(false);
    if (process.platform !== 'win32') expect(fs.existsSync(getServerSocketPath())).toBe(false);
  });

  it('with onlyIfOlderThan keeps a server of the same, a newer or an unknown release', async () => {
    const server = await startServerProcess(getServerSocketPath(), '1.4.0');
    const written = writeLock({ pid: server.pid!, version: '1.4.0' });
    for (const caller of ['1.4.0', '1.3.9', '0.9.0', 'unknown', '1.5.0-beta.1']) {
      expect(await stopServer({ onlyIfOlderThan: caller, graceMs: 200 }))
        .toEqual({ outcome: 'kept', pid: server.pid, version: '1.4.0' });
      expect(isProcessAlive(server.pid!)).toBe(true);
    }
    expect(readServerLock()).toEqual(written);
  });

  it('with onlyIfOlderThan keeps a server whose recorded version is the unknown sentinel, whatever the caller', async () => {
    const server = await startServerProcess(getServerSocketPath(), '0.0.0-unknown');
    writeLock({ pid: server.pid!, version: '0.0.0-unknown' });
    expect((await stopServer({ onlyIfOlderThan: '9.9.9', graceMs: 200 })).outcome).toBe('kept');
    expect(isProcessAlive(server.pid!)).toBe(true);
  });

  it('with onlyIfOlderThan stops a server of an older release', async () => {
    const server = await startServerProcess(getServerSocketPath(), '1.4.0');
    writeLock({ pid: server.pid!, version: '1.4.0' });
    const result = await stopServer({ onlyIfOlderThan: '1.4.1', graceMs: 5_000 });
    expect(result).toEqual({ outcome: 'stopped', pid: server.pid, version: '1.4.0' });
    expect(await waitDead(server.pid!)).toBe(true);
  });

  it('reports still-running, without escalating to SIGKILL, when a verified server outlives the wait', async () => {
    const server = await startServerProcess(getServerSocketPath(), '1.0.0', true);
    const written = writeLock({ pid: server.pid!, version: '1.0.0' });
    const result = await stopServer({ graceMs: 300 });
    expect(result).toEqual({ outcome: 'still-running', pid: server.pid, version: '1.0.0' });
    expect(isProcessAlive(server.pid!)).toBe(true);
    expect(server.signalCode).toBeNull();
    // Its lock stays: it is still the server.
    expect(readServerLock()).toEqual(written);
  });
});

describe('requestProjectRelease', () => {
  const root = path.join(os.tmpdir(), 'some-project-root');

  it('is no-server when nothing answers on the state dir\'s sockets', async () => {
    expect(await requestProjectRelease(root, 1_000)).toBe('no-server');
  });

  it('is no-server for a stale socket file nothing listens on', async () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(getServerSocketPath(), 'stale');
    expect(await requestProjectRelease(root, 1_000)).toBe('no-server');
  });

  it('sends a client hello without launchDir, then the release request, and resolves released on the reply', async () => {
    fake = await startFakeServer();
    expect(await requestProjectRelease(root, 5_000)).toBe('released');
    expect(fake.clientHellos).toEqual([{ codegraph_client: 1, control: 1, pid: process.pid, hostPid: null }]);
    expect(fake.clientHellos[0]).not.toHaveProperty('launchDir');
    expect(fake.requests).toEqual([
      { jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root } },
    ]);
  });

  it('is failed when the server replies with an error', async () => {
    fake = await startFakeServer({ reply: () => ({ error: { code: -32603, message: 'boom' } }) });
    expect(await requestProjectRelease(root, 5_000)).toBe('failed');
  });

  it('is failed when the reply is not a release confirmation', async () => {
    fake = await startFakeServer({ reply: () => ({ result: {} }) });
    expect(await requestProjectRelease(root, 5_000)).toBe('failed');
  });

  it('is failed when the server stays silent past the timeout', async () => {
    fake = await startFakeServer({ reply: () => null });
    const started = Date.now();
    expect(await requestProjectRelease(root, 300)).toBe('failed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('is failed when what answers sends no server hello', async () => {
    fake = await startFakeServer({ hello: { not: 'a hello' } });
    expect(await requestProjectRelease(root, 5_000)).toBe('failed');
    expect(fake.requests).toEqual([]);
  });

  it('reaches the socket the lock records, when it is not the preferred candidate', async () => {
    if (process.platform === 'win32') return;
    // A server bound elsewhere (the fallback location the lock's socketPath names).
    const elsewhere = path.join(stateDir, 'elsewhere.sock');
    const server = await startServerProcessReleasing(elsewhere);
    try {
      writeLock({ pid: process.pid, socketPath: elsewhere });
      expect(await requestProjectRelease(root, 5_000)).toBe('released');
    } finally {
      await server.close();
    }
  });
});

/** A one-off fake bound to a given path: the lock's own socket. */
async function startServerProcessReleasing(socketPath: string): Promise<{ close(): Promise<void> }> {
  const net = await import('net');
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(JSON.stringify({ codegraph: 'fake', pid: process.pid, socketPath, protocol: 1 }) + '\n');
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        if (line.method === 'codegraph/releaseProject') {
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: line.id, result: { released: true } }) + '\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  // The client destroys its side once it has the reply, so close() settles.
  return { close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }) };
}
