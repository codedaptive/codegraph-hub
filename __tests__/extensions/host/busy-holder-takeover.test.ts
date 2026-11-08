import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as daemonPaths from '../../../src/mcp/daemon-paths';
import type { ServerLockInfo } from '../../../src/mcp/daemon-paths';
import { getStateDirIdentity } from '../../../src/extensions/host/server/state-dir';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';

type HelloAnswer = 'match' | 'mismatch' | 'no-answer';
// Keep the missing export an assertion failure until the new API lands, while
// still typechecking this test against the pre-change tree.
function probeHello(info: ServerLockInfo, timeoutMs = 300): Promise<HelloAnswer> {
  const probe = (daemonPaths as unknown as {
    probeServerHello?: (info: ServerLockInfo, timeoutMs?: number) => Promise<HelloAnswer>;
  }).probeServerHello;
  expect(probe, 'probeServerHello must be exported').toBeTypeOf('function');
  return probe!(info, timeoutMs);
}

const posix = process.platform !== 'win32';
const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(posix)('server hello classification and busy-holder takeover', () => {
  let dir: string;
  let priorStateDir: string | undefined;
  let holder: net.Server | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const accepted: net.Socket[] = [];

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-busy-')));
    priorStateDir = process.env.CODEGRAPH_STATE_DIR;
    process.env.CODEGRAPH_STATE_DIR = dir;
  });

  afterEach(asyncCleanup);

  async function asyncCleanup(): Promise<void> {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exiting = new Promise<void>((resolve) => child!.once('close', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exiting, sleep(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exiting, sleep(2_000)]);
      }
    }
    child = undefined;
    for (const socket of accepted.splice(0)) socket.destroy();
    if (holder) await new Promise<void>((resolve) => holder!.close(() => resolve()));
    holder = undefined;
    if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function info(socketPath = path.join(dir, 'server.sock')): ServerLockInfo {
    return {
      pid: process.pid,
      version: CodeGraphPackageVersion,
      socketPath,
      startedAt: Date.now() - 60_000,
      stateDir: dir,
      stateId: getStateDirIdentity()!,
    };
  }

  async function listen(onConnect: (socket: net.Socket) => void): Promise<ServerLockInfo> {
    const lock = info();
    holder = net.createServer((socket) => {
      accepted.push(socket);
      onConnect(socket);
    });
    await new Promise<void>((resolve, reject) => {
      holder!.once('error', reject);
      holder!.listen(lock.socketPath, resolve);
    });
    return lock;
  }

  function hello(lock: ServerLockInfo, changes: Record<string, unknown> = {}): string {
    return JSON.stringify({ protocol: 1, pid: lock.pid, codegraph: lock.version, ...changes }) + '\n';
  }

  it('classifies an accepted silent socket as no-answer', async () => {
    const lock = await listen(() => {});
    expect(await probeHello(lock)).toBe('no-answer');
  });

  it('classifies a matching complete hello as match', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock)));
    expect(await probeHello(lock)).toBe('match');
  });

  it('classifies a hello naming another pid as mismatch', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { pid: lock.pid + 1 })));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies a hello naming another version as mismatch', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { codegraph: 'other-version' })));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies a hello naming another protocol as mismatch', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { protocol: 2 })));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies an unparsable hello line as mismatch', async () => {
    const lock = await listen((socket) => socket.write('{not json}\n'));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies a close before a complete line as mismatch', async () => {
    const lock = await listen((socket) => socket.end('{"protocol":1'));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies more than 4096 bytes without a newline as mismatch', async () => {
    const lock = await listen((socket) => socket.write('x'.repeat(4097)));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies a partial line followed by silence as mismatch', async () => {
    const lock = await listen((socket) => socket.write('{"protocol":1'));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies an oversized completed matching hello as mismatch', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { padding: 'x'.repeat(4097) })));
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('keeps the boolean identity probe false for an oversized completed matching hello', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { padding: 'x'.repeat(4097) })));
    expect(await daemonPaths.probeServerIdentity(lock, 300)).toBe(false);
  });

  // No deterministic way to hold a local Unix socket in the connecting state on macOS:
  // backlog saturation and scheduler timing cannot guarantee timeout precedes connect.
  it.skip('classifies a timeout before connect as mismatch', () => {});

  it('classifies a missing socket file as mismatch', async () => {
    expect(await probeHello(info())).toBe('mismatch');
  });

  it('classifies a refused connection as mismatch', async () => {
    const lock = await listen(() => {});
    await new Promise<void>((resolve) => holder!.close(() => resolve()));
    holder = undefined;
    // Closing a Unix server unlinks the socket; leave an ordinary file to make
    // the path exist while no listener is available.
    fs.writeFileSync(lock.socketPath, 'not a socket');
    expect(await probeHello(lock)).toBe('mismatch');
  });

  it('classifies invalid pids and an empty socket path as mismatch', async () => {
    for (const pid of [0, -1, 1.5]) {
      expect(await probeHello({ ...info(), pid })).toBe('mismatch');
    }
    expect(await probeHello(info(''))).toBe('mismatch');
  });

  it('keeps the boolean identity probe false for an accepted silent socket', async () => {
    const lock = await listen(() => {});
    expect(await daemonPaths.probeServerIdentity(lock, 300)).toBe(false);
  });

  it('keeps the boolean identity probe true for a matching hello', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock)));
    expect(await daemonPaths.probeServerIdentity(lock, 300)).toBe(true);
  });

  it('keeps the boolean identity probe false for a mismatched hello', async () => {
    let lock: ServerLockInfo;
    lock = await listen((socket) => socket.write(hello(lock, { pid: lock.pid + 1 })));
    expect(await daemonPaths.probeServerIdentity(lock, 300)).toBe(false);
  });

  // A real server candidate must finish its 1s hello probe; the 8s bound also
  // allows process startup under load and detects a candidate that keeps serving.
  it('leaves an old live silent holder and its lock untouched without serving', async () => {
    const lock = await listen(() => {});
    const pidPath = path.join(dir, 'server.pid');
    const original = daemonPaths.encodeServerLock(lock);
    fs.writeFileSync(pidPath, original);
    child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEGRAPH_STATE_DIR: dir,
        CODEGRAPH_DAEMON_INTERNAL: '1',
        CODEGRAPH_NO_WATCHDOG: '1',
        CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
        CODEGRAPH_NO_RELAUNCH: '1',
        CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
        DO_NOT_TRACK: '1',
        CODEGRAPH_TELEMETRY: '0',
      },
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.on('error', () => {});
    const deadline = Date.now() + 8_000;
    while (child.exitCode === null && child.signalCode === null && !output.includes('Listening on') && Date.now() < deadline) {
      await sleep(25);
    }

    expect.soft(child.exitCode, `candidate should exit successfully; output: ${output}`).toBe(0);
    expect.soft(fs.readFileSync(pidPath, 'utf8'), 'holder lock bytes must remain unchanged').toBe(original);
    const priorConnections = accepted.length;
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(lock.socketPath);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1_000, () => { socket.destroy(); resolve(false); });
    });
    const acceptDeadline = Date.now() + 1_000;
    while (accepted.length === priorConnections && Date.now() < acceptDeadline) await sleep(10);
    expect.soft(connected && accepted.length > priorConnections, 'the original holder must still accept connections').toBe(true);
    expect.soft(output).not.toContain('Listening on');
  }, 15_000);
});
