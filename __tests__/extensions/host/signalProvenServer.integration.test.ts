import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { signalProvenServer } from '../../../src/extensions/host/server/signalProvenServer';
import { encodeServerLock } from '../../../src/mcp/daemon-paths';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { stateIdentityOf } from './state-identity';

let stateDir: string;
let pidPath: string;
let children: ChildProcess[];

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-signal-')));
  pidPath = path.join(stateDir, 'server.pid');
  children = [];
  vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A child that prints 'ready' once `source` has run, so a SIGTERM handler it installs is in place. */
async function startChild(source: string): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', `${source}; console.log('ready')`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('child exited before ready')));
    child.stdout?.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
  });
  const { pid } = child;
  if (pid === undefined) throw new Error('child has no pid');
  return Object.assign(child, { pid });
}

function writeLock(pid: number, startedAt: number): string {
  const raw = encodeServerLock({
    pid, version: '1.2.3-test', socketPath: path.join(stateDir, 'server.sock'), startedAt,
    stateDir, stateId: stateIdentityOf(stateDir),
  });
  fs.writeFileSync(pidPath, raw);
  return raw;
}

describe('signalProvenServer', () => {
  it('stops the proven pid and removes its unchanged lock', async () => {
    const child = await startChild('setInterval(() => {}, 1e9)');
    const raw = writeLock(child.pid, 1);
    const exited = once(child, 'exit');

    expect(await signalProvenServer(child.pid, pidPath, raw, 10_000, isProcessAlive)).toBe('stopped');
    await exited;
    expect(child.signalCode).toBe('SIGTERM');
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('reports still-running for a pid that ignores SIGTERM and keeps its lock', async () => {
    const child = await startChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9)");
    const raw = writeLock(child.pid, 1);

    expect(await signalProvenServer(child.pid, pidPath, raw, 300, isProcessAlive)).toBe('still-running');
    expect(isProcessAlive(child.pid)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(raw);
  });

  it('signals nothing when the lock changed since it was proven', async () => {
    const child = await startChild('setInterval(() => {}, 1e9)');
    const proven = writeLock(child.pid, 1);
    const successor = writeLock(child.pid, 2);
    expect(successor).not.toBe(proven);
    // Liveness alone can't see a SIGTERM the child has not acted on yet; the spy sees the call itself.
    const kill = vi.spyOn(process, 'kill');

    expect(await signalProvenServer(child.pid, pidPath, proven, 300, isProcessAlive)).toBe('unverified');
    expect(kill).not.toHaveBeenCalledWith(child.pid, 'SIGTERM');
    expect(isProcessAlive(child.pid)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(successor);
  });
});
