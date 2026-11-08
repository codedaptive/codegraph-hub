import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Daemon, tryAcquireDaemonLock } from '../../../src/mcp/daemon';
import { decodeServerLock, encodeServerLock } from '../../../src/mcp/daemon-paths';
import * as serverControl from '../../../src/mcp/server-control';

// The namespace keeps the new API's absence a test failure without preventing
// the existing Daemon shutdown tests from running before the implementation.
const resolveGrace = (env: NodeJS.ProcessEnv) =>
  (serverControl as unknown as { resolveServerStopGraceMs: (env: NodeJS.ProcessEnv) => number })
    .resolveServerStopGraceMs(env);

describe('resolveServerStopGraceMs', () => {
  it('defaults to 15 seconds when unset', () => {
    expect(resolveGrace({})).toBe(15_000);
  });

  it('accepts a non-negative integer, including zero', () => {
    expect(resolveGrace({ CODEGRAPH_SERVER_STOP_GRACE_MS: '317' })).toBe(317);
    expect(resolveGrace({ CODEGRAPH_SERVER_STOP_GRACE_MS: '0' })).toBe(0);
  });

  it.each(['not-a-number', '-1', '1.5'])("defaults for invalid value %s", (value) => {
    expect(resolveGrace({ CODEGRAPH_SERVER_STOP_GRACE_MS: value })).toBe(15_000);
  });

  it('caps values above 120 seconds', () => {
    expect(resolveGrace({ CODEGRAPH_SERVER_STOP_GRACE_MS: '120001' })).toBe(120_000);
  });
});

describe.skipIf(process.platform === 'win32')('Daemon POSIX shutdown', () => {
  let dir: string;
  let daemon: any;
  let realEngineStop: () => Promise<void>;
  let realBuilderStop: () => Promise<void>;
  let owner: net.Server | undefined;
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;
  let initialSignals: Record<'SIGINT' | 'SIGTERM', NodeJS.SignalsListener[]>;
  const saved = {
    CODEGRAPH_STATE_DIR: process.env.CODEGRAPH_STATE_DIR,
    CODEGRAPH_QUERY_POOL_SIZE: process.env.CODEGRAPH_QUERY_POOL_SIZE,
    CODEGRAPH_SERVER_STOP_GRACE_MS: process.env.CODEGRAPH_SERVER_STOP_GRACE_MS,
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stop-')));
    process.env.CODEGRAPH_STATE_DIR = dir;
    process.env.CODEGRAPH_QUERY_POOL_SIZE = '0';
    process.env.CODEGRAPH_SERVER_STOP_GRACE_MS = '300';
    initialSignals = {
      SIGINT: process.listeners('SIGINT') as NodeJS.SignalsListener[],
      SIGTERM: process.listeners('SIGTERM') as NodeJS.SignalsListener[],
    };
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    daemon = new Daemon() as any;
    realEngineStop = daemon.engine.stop.bind(daemon.engine);
    realBuilderStop = daemon.builder.stop.bind(daemon.builder);
  });

  afterEach(async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!initialSignals[signal].includes(listener as NodeJS.SignalsListener)) {
          process.removeListener(signal, listener as NodeJS.SignalsListener);
        }
      }
    }
    if (daemon.clientSweepTimer) clearInterval(daemon.clientSweepTimer);
    if (daemon.installCheckTimer) clearInterval(daemon.installCheckTimer);
    if (daemon.server?.listening) await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
    if (owner?.listening) await new Promise<void>((resolve) => owner!.close(() => resolve()));
    owner = undefined;
    await realEngineStop();
    await realBuilderStop();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startDaemon() {
    expect(tryAcquireDaemonLock().kind).toBe('acquired');
    daemon.engine.stop = vi.fn(async () => {});
    daemon.builder.stop = vi.fn(async () => {});
    return await daemon.start();
  }

  async function bindOwner(socketPath: string) {
    owner = net.createServer((socket) => socket.end('owner'));
    await new Promise<void>((resolve, reject) => {
      owner!.once('error', reject);
      owner!.listen(socketPath, resolve);
    });
  }

  async function readOwner(socketPath: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { received += chunk; });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
  }

  it('leaves a replacement owner socket reachable and its lock untouched', async () => {
    const { socketPath, lock } = await startDaemon();
    fs.unlinkSync(socketPath);
    await bindOwner(socketPath);
    fs.writeFileSync(path.join(dir, 'server.pid'), encodeServerLock({ ...lock, pid: process.ppid }));

    await daemon.stop('SIGTERM');

    expect(fs.existsSync(socketPath)).toBe(true);
    expect(await readOwner(socketPath)).toBe('owner');
    expect(decodeServerLock(fs.readFileSync(path.join(dir, 'server.pid'), 'utf8'))?.pid).toBe(process.ppid);
  });

  it('leaves a replacement socket even if the lock still names this process', async () => {
    const { socketPath } = await startDaemon();
    fs.unlinkSync(socketPath);
    await bindOwner(socketPath);

    await daemon.stop('SIGTERM');

    expect(fs.existsSync(socketPath)).toBe(true);
    expect(await readOwner(socketPath)).toBe('owner');
  });

  it('leaves its original socket when the lock now names another process', async () => {
    const { socketPath, lock } = await startDaemon();
    fs.writeFileSync(path.join(dir, 'server.pid'), encodeServerLock({ ...lock, pid: process.ppid }));

    await daemon.stop('SIGTERM');

    expect(fs.existsSync(socketPath)).toBe(true);
    expect(decodeServerLock(fs.readFileSync(path.join(dir, 'server.pid'), 'utf8'))?.pid).toBe(process.ppid);
  });

  it('removes its own socket and its own lock without a takeover', async () => {
    const { socketPath } = await startDaemon();
    await daemon.stop('SIGTERM');
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'server.pid'))).toBe(false);
  });

  // POSIX's overall bound is the grace plus the builder's separate 5 s cap;
  // these stubs finish the builder immediately, so assert grace + 1 s instead.
  // Windows adds a 2 s drain backstop and is untested here (sm.14, R-21).
  async function finishesWithinMargin(promise: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1_300); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('stops every client and exits within grace plus one second when the engine hangs', async () => {
    const clients = Array.from({ length: 53 }, (_, i) => ({
      stop: vi.fn(() => { if (i === 0) throw new Error('broken client'); }),
    }));
    for (const client of clients) daemon.clients.add(client);
    daemon.engine.stop = vi.fn(() => new Promise<void>(() => {}));
    daemon.builder.stop = vi.fn(async () => {});

    const finished = await finishesWithinMargin(daemon.stop('SIGTERM'));

    expect(clients.every((client) => client.stop.mock.calls.length === 1)).toBe(true);
    expect(finished, 'shutdown must finish within 300 ms grace + 1 s').toBe(true);
    expect(daemon.builder.stop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toMatch(/grace|timed?\s*out|expir/i);
  });

  it('stops the builder after the grace when engine shutdown depends on it', async () => {
    let unblock!: () => void;
    const waiting = new Promise<void>((resolve) => { unblock = resolve; });
    daemon.engine.stop = vi.fn(() => waiting);
    let builderAt = 0;
    daemon.builder.stop = vi.fn(async () => { builderAt = Date.now(); unblock(); });
    const started = Date.now();

    const finished = await finishesWithinMargin(daemon.stop('SIGTERM'));

    expect(finished, 'shutdown must break the engine-builder dependency').toBe(true);
    expect(daemon.builder.stop).toHaveBeenCalledOnce();
    expect(builderAt - started).toBeGreaterThanOrEqual(250);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('cleans its lock and exits even if engine shutdown rejects', async () => {
    expect(tryAcquireDaemonLock().kind).toBe('acquired');
    daemon.engine.stop = vi.fn(async () => { throw new Error('engine failure'); });
    daemon.builder.stop = vi.fn(async () => {});

    // The real exit does not return; a mocked exit may leave the rejection observable.
    await daemon.stop('SIGTERM').catch(() => {});
    expect(daemon.builder.stop).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(dir, 'server.pid'))).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('cleans its lock and exits even if builder shutdown rejects', async () => {
    expect(tryAcquireDaemonLock().kind).toBe('acquired');
    daemon.engine.stop = vi.fn(async () => {});
    daemon.builder.stop = vi.fn(async () => { throw new Error('builder failure'); });

    await daemon.stop('SIGTERM').catch(() => {});
    expect(fs.existsSync(path.join(dir, 'server.pid'))).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
