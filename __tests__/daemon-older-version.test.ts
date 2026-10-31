/**
 * A launcher replaces a machine server from an older install (#2335).
 *
 * A server keeps running the code it started with. The 1.6.1 daemon in #2335
 * outlived an upgrade to 1.6.2, went on loading grammars from the install the
 * upgrade removed, and wrote every file its watcher re-indexed as empty. A
 * launcher that found it could only serve its own session in-process, read-only.
 * Servers from before the fix cannot notice the upgrade themselves, so the
 * launcher acts: a server of an OLDER release is stopped the way `codegraph
 * daemon` stops one (`stopServer`: identity-checked SIGTERM, a graceful shutdown
 * on POSIX) and one from the launcher's own install takes its place. The
 * launcher hears an older server's hello on the state dir's socket, or — when it
 * listens elsewhere — finds it by the state dir's lock. A server of the same, a
 * newer or an unknown version is never touched, so two installed versions
 * cannot fight over the server. (The stop primitive itself is unit-tested in
 * extensions/host/server-control.unit.test.ts.)
 *
 * The end-to-end cases run real servers of other versions: this build's dist/
 * linked into a temp "install" whose package.json carries another version. A
 * server resolves its version, and every grammar it loads, from its own files,
 * so that install's server advertises that version in its lock and its hello.
 * Every case has its own state dir, so the live server is never touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stateIdentityOf } from './extensions/host/state-identity';
import { connectWithHello } from '../src/mcp/proxy';
import { CodeGraphPackageVersion, isOlderRelease } from '../src/mcp/version';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const DIST = path.resolve(__dirname, '../dist');
const NODE_MODULES = path.resolve(__dirname, '../node_modules');
const OLDER_DAEMON = path.resolve(__dirname, 'fixtures/older-daemon.cjs');

/** Plain releases always below / above any version this repo will carry. */
const OLDER = '0.0.1';
const NEWER = '999.0.0';

describe('isOlderRelease', () => {
  it('orders plain releases numerically', () => {
    expect(isOlderRelease('1.6.1', '1.6.2')).toBe(true);
    expect(isOlderRelease('1.6.9', '1.6.10')).toBe(true);
    expect(isOlderRelease('1.9.0', '1.10.0')).toBe(true);
    expect(isOlderRelease('0.99.99', '1.0.0')).toBe(true);
    expect(isOlderRelease('1.6.2', '1.6.2')).toBe(false);
    expect(isOlderRelease('1.6.3', '1.6.2')).toBe(false);
    expect(isOlderRelease('2.0.0', '1.99.99')).toBe(false);
  });

  it('never calls a prerelease, a build or an unknown version older, in either position', () => {
    for (const odd of ['0.0.0-unknown', '0.0.0-mismatch', '1.6.1-beta.1', '1.6.1+local', 'v1.6.1', 'unknown', 'test', '', '1.6']) {
      expect(isOlderRelease(odd, '1.6.2'), odd).toBe(false);
      expect(isOlderRelease('1.6.1', odd), odd).toBe(false);
    }
  });

  it('lets at most one of two versions replace the other', () => {
    const versions = ['0.9.0', '1.6.1', '1.6.2', '1.6.10', '1.7.0', '2.0.0', '1.6.2-rc.1', '0.0.0-unknown'];
    for (const a of versions) {
      for (const b of versions) {
        expect(isOlderRelease(a, b) && isOlderRelease(b, a), `${a} / ${b}`).toBe(false);
      }
    }
  });
});

/** A path a test server can listen on: a named pipe on Windows, a socket file elsewhere. */
function listenPath(dir: string, name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(dir)}-${name}`
    : path.join(dir, `${name}.sock`);
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

describe('connectWithHello', () => {
  let dir: string;
  let server: net.Server | null = null;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hello-')); });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [OLDER, 'older-version', false],
    [NEWER, 'version-mismatch', true],
    ['0.0.0-unknown', 'version-mismatch', true],
  ])('reports a %s server as %s', async (version, expected, logged) => {
    const socketPath = listenPath(dir, 'daemon');
    server = net.createServer((socket) => {
      socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    });
    await listen(server, socketPath);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await connectWithHello(socketPath, '1.6.2')).toBe(expected);
      // An older server is the launcher's to report; it is not a mismatch to serve around.
      expect(stderr.mock.calls.some(([line]) => String(line).includes('differs from ours'))).toBe(logged);
    } finally {
      stderr.mockRestore();
    }
  });

  it('sends its pids and the launch directory in the client hello, right after verifying the server hello', async () => {
    const socketPath = listenPath(dir, 'daemon');
    const received: string[] = [];
    server = net.createServer((socket) => {
      socket.write(JSON.stringify({ codegraph: '1.6.2', pid: process.pid, socketPath, protocol: 1 }) + '\n');
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => received.push(String(chunk)));
    });
    await listen(server, socketPath);
    const launchDir = path.join(dir, 'launch');
    const socket = await connectWithHello(socketPath, '1.6.2', 3_000, launchDir);
    expect(typeof socket).toBe('object');
    const line = await vi.waitFor(() => {
      const first = received.join('').split('\n')[0];
      if (!first) throw new Error('no client hello yet');
      return first;
    });
    expect(JSON.parse(line)).toMatchObject({ codegraph_client: 1, pid: process.pid, launchDir });
    (socket as net.Socket).destroy();
  });
});

/**
 * A CodeGraph install of `version`: this build's dist/, hard-linked file by
 * file (copied where a link is refused), next to a package.json of that version
 * and a link to this checkout's node_modules.
 */
function makeInstall(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-install-${version}-`));
  const linkTree = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) linkTree(source, target);
      else {
        try { fs.linkSync(source, target); } catch { fs.copyFileSync(source, target); }
      }
    }
  };
  linkTree(DIST, path.join(dir, 'dist'));
  fs.symlinkSync(NODE_MODULES, path.join(dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version }) + '\n');
  return dir;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function lines(stream: NodeJS.ReadableStream, into: string[]): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      into.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });
}

function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      let value: T | undefined | null | false;
      try { value = predicate(); } catch (e) { reject(e); return; }
      if (value) { resolve(value as T); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`)); return; }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs, `pid ${pid} to exit`).then(() => true, () => false);
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

describe('a launcher meeting a server of another version (#2335)', () => {
  let olderInstall: string;
  let newerInstall: string;
  let tempDir: string;
  let realRoot: string;
  let stateDir: string;
  const sessions: Session[] = [];
  const serverPids = new Set<number>();

  beforeAll(() => {
    olderInstall = makeInstall(OLDER);
    newerInstall = makeInstall(NEWER);
  });

  afterAll(async () => {
    for (const dir of [olderInstall, newerInstall]) {
      if (!dir) continue;
      // The link first: removing an install must never reach this checkout's modules.
      try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch { /* not created */ }
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-older-version-'));
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-older-state-')));
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function appMain() { return 1; }\n');
    const cg = await CodeGraph.init(tempDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    realRoot = fs.realpathSync(tempDir);
  });

  afterEach(async () => {
    // Every launcher first (with the runtime flags there is no relaunch child),
    // then the losing server candidates, then the servers themselves — and only
    // then the fixture: on Windows a live process inside it blocks the removal.
    await Promise.all(sessions.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    sessions.length = 0;
    const lockPid = (): number | null => readJson(path.join(stateDir, 'server.pid'))?.pid ?? null;
    await settleLosingCandidates(tempDir, lockPid);
    const holder = lockPid();
    if (holder) serverPids.add(holder);
    for (const pid of serverPids) {
      if (pid === process.pid || !isAlive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
      await waitProcessExit(pid, 5000);
    }
    serverPids.clear();
    removeSpawnLog(tempDir);
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.promises.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 45_000);

  /** An agent session: `install`'s launcher, `serve --mcp` in the project. */
  function startSession(install: string | null, env: NodeJS.ProcessEnv = {}): Session {
    const bin = install ? path.join(install, 'dist', 'bin', 'codegraph.js') : BIN;
    const recorder = recordSpawns(tempDir);
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, bin, 'serve', '--mcp'], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_MCP_LOG_ATTACH: '1',
        CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
        CODEGRAPH_STATE_DIR: stateDir,
        ...recorder.env,
        ...env,
      },
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => { /* ignore */ });
    child.stdin.on('error', () => { /* ignore */ });
    const session: Session = { child, stdout: [], stderr: [] };
    lines(child.stdout, session.stdout);
    lines(child.stderr, session.stderr);
    sessions.push(session);
    send(session, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    });
    return session;
  }

  function send(session: Session, msg: unknown): void {
    try { session.child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* gone */ }
  }

  /** `codegraph_status` for the project, which every call must name. */
  function sendStatus(session: Session, id: number): void {
    send(session, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'codegraph_status', arguments: { projectPath: tempDir } } });
  }

  async function status(session: Session, id: number, label: string): Promise<any> {
    sendStatus(session, id);
    const reply = await waitFor(() => findResponse(session.stdout, id), 20000, label).catch((err: Error) => {
      throw new Error(`${err.message}\n--- stderr ---\n${session.stderr.join('\n')}\n--- server.log ---\n${serverLog()}`);
    });
    expect(reply.error, label).toBeUndefined();
    expect(reply.result?.isError, label).not.toBe(true);
    expect(JSON.stringify(reply.result), label).toContain('CodeGraph Status');
    return reply;
  }

  const attachedLine = (session: Session): string | undefined =>
    session.stderr.find((l) => l.includes('Attached to shared daemon'));
  const serverLock = (): any => readJson(path.join(stateDir, 'server.pid'));
  const writerLock = (): any => readJson(path.join(realRoot, '.codegraph', 'writer.pid'));
  const serverLog = (): string => {
    try { return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8'); } catch { return ''; }
  };

  /** A session of `install` attached to a server of its own, which owns the state dir. */
  async function sessionWithServer(install: string, version: string, env: NodeJS.ProcessEnv = {}): Promise<{ session: Session; pid: number }> {
    const session = startSession(install, env);
    await waitFor(() => attachedLine(session), 20000, `the ${version} session to attach`);
    // Attached means listening, not that a project is open: let a call open the
    // database before anything stops this server.
    await status(session, 2, `a ${version} tool call`);
    const lock = serverLock();
    expect(lock).toMatchObject({ version, stateDir });
    serverPids.add(lock.pid);
    return { session, pid: lock.pid };
  }

  it('keeps the older server\'s sessions answering through the replacement, even mid-call', async () => {
    const before = await sessionWithServer(olderInstall, OLDER);
    // The older session calls every 20ms throughout, so it serves itself
    // in-process the instant its server goes: every call must still get its one
    // reply, and that engine only ever reads.
    let next = 100;
    const calling = setInterval(() => sendStatus(before.session, next++), 20);
    let after: Session;
    try {
      after = startSession(null);
      await waitFor(() => attachedLine(after), 30000, 'the new session to attach');
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearInterval(calling);
    }
    const lock = serverLock();
    serverPids.add(lock.pid);
    expect(lock.version).toBe(CodeGraphPackageVersion);
    await status(after, 2, 'a tool call through the new server');

    const last = next - 1;
    await waitFor(() => findResponse(before.session.stdout, last), 20000, 'the older session to answer every call');
    for (let id = 100; id <= last; id++) expect(findResponse(before.session.stdout, id), `call ${id}`).toBeTruthy();
    const stderr = before.session.stderr.join('\n');
    expect(stderr).toContain('Serving reads in-process without auto-sync');
    expect(stderr).not.toContain('File watcher active');
  }, 120000);

  it('stops a server from an older install and starts one from its own', async () => {
    const before = await sessionWithServer(olderInstall, OLDER);

    const after = startSession(null);
    const stopped = await waitFor(
      () => after.stderr.find((l) => l.includes('[CodeGraph MCP] Stopped')),
      30000, 'the older server to be stopped',
    );
    expect(stopped).toContain(`the CodeGraph ${OLDER} server (pid ${before.pid})`);
    expect(stopped).toContain(`from this install (${CodeGraphPackageVersion})`);
    expect(await waitProcessExit(before.pid, 10000)).toBe(true);

    const attached = await waitFor(() => attachedLine(after), 20000, 'the new session to attach');
    const lock = serverLock();
    serverPids.add(lock.pid);
    expect(lock.version).toBe(CodeGraphPackageVersion);
    expect(lock.pid).not.toBe(before.pid);
    expect(attached).toContain(`(pid ${lock.pid}, v${CodeGraphPackageVersion})`);
    await status(after, 2, 'a tool call through the new server');
    if (process.platform !== 'win32') {
      // SIGTERM ran the old server's own shutdown. (On Windows it is
      // TerminateProcess, and the stop clears what is left.)
      expect(serverLog()).toContain('Shutting down (SIGTERM');
    }

    // The session from before the upgrade keeps answering, read-only.
    await waitFor(
      () => before.session.stderr.some((l) => l.includes('Shared daemon connection lost')),
      10000, 'the older session to lose its server',
    );
    await status(before.session, 3, 'a tool call in the older session');
    expect(before.session.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
    expect(serverLock()).toEqual(lock);
    expect(isAlive(lock.pid)).toBe(true);
  }, 120000);

  it('finds an older server listening off the socket candidates by the state dir\'s lock, and stops it', async () => {
    // A launcher's probe walks the lock's socket and then the state dir's socket
    // candidates, so a server listening elsewhere is found only because the lock
    // says where it is. Stand one up on a socket that is not a candidate.
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sock-'));
    try {
      const socketPath = listenPath(socketDir, 'older');
      const older = spawn(process.execPath, [OLDER_DAEMON, stateDir, OLDER, socketPath, stateIdentityOf(stateDir)], { detached: true, stdio: 'ignore' });
      older.unref();
      serverPids.add(older.pid!);
      await waitFor(() => serverLock()?.pid === older.pid, 10000, 'the older server to hold the state dir');

      const session = startSession(null);
      const stopped = await waitFor(
        () => session.stderr.find((l) => l.includes('[CodeGraph MCP] Stopped')),
        30000, 'the older server to be stopped',
      );
      expect(stopped).toContain(`the CodeGraph ${OLDER} server (pid ${older.pid})`);
      expect(await waitProcessExit(older.pid!, 10000)).toBe(true);
      const attached = await waitFor(() => attachedLine(session), 20000, 'the session to attach');
      const lock = serverLock();
      serverPids.add(lock.pid);
      expect(lock.version).toBe(CodeGraphPackageVersion);
      expect(attached).toContain(`(pid ${lock.pid}, v${CodeGraphPackageVersion})`);
      await status(session, 2, 'a tool call through the new server');
    } finally {
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  }, 90000);

  it('never stops a server from a newer install', async () => {
    const retry = { CODEGRAPH_DAEMON_RETRY_MS: '300', CODEGRAPH_DAEMON_RETRY_MAX_MS: '600' };
    const newer = await sessionWithServer(newerInstall, NEWER);
    const lock = serverLock();

    const current = startSession(null, retry);
    // The first probe and the retries that follow all find the newer server.
    await waitFor(
      () => current.stderr.filter((l) => l.includes(`version (${NEWER}) differs from ours`)).length >= 3,
      20000, 'repeated probes of the newer server',
    );
    await status(current, 2, 'a tool call served in-process');
    expect(current.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
    expect(current.stderr.some((l) => l.includes('[CodeGraph MCP] Stopped'))).toBe(false);

    expect(isAlive(newer.pid)).toBe(true);
    expect(serverLock()).toEqual(lock);
    await status(newer.session, 3, 'a tool call through the newer server');
  }, 90000);

  it('a session whose own install was upgraded keeps answering in-process once its server exits', async () => {
    // An upgrade in place: the server notices its package.json changed and
    // exits (its install check), and its session falls back in-process, where
    // it only reads and claims no writer slot, so a server from the new install
    // starts straight away.
    const install = makeInstall('0.0.2');
    try {
      const before = await sessionWithServer(install, '0.0.2', {
        CODEGRAPH_DAEMON_INSTALL_CHECK_MS: '200',
        CODEGRAPH_DAEMON_RETRY_MS: '0',
      });
      fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version: '0.0.3' }) + '\n');
      expect(await waitProcessExit(before.pid, 10000)).toBe(true);
      expect(serverLog()).toContain('Install replaced by v0.0.3');
      await waitFor(
        () => before.session.stderr.some((l) => l.includes('Shared daemon connection lost')),
        10000, 'the session to lose its server',
      );

      await status(before.session, 3, 'a tool call after the server exited');
      const stderr = before.session.stderr.join('\n');
      expect(stderr).toContain('Serving reads in-process without auto-sync');
      expect(stderr).not.toContain('File watcher active');
      expect(writerLock()).toBeNull();

      // So a session from the current install gets a server straight away.
      const after = startSession(null);
      await waitFor(() => attachedLine(after), 20000, 'the new session to attach');
      const lock = serverLock();
      serverPids.add(lock.pid);
      expect(lock.version).toBe(CodeGraphPackageVersion);
    } finally {
      // On Windows a process still running from the install blocks its removal.
      for (const { child } of sessions) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }
      try { fs.unlinkSync(path.join(install, 'node_modules')); } catch { /* not created */ }
      await fs.promises.rm(install, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90000);
});
