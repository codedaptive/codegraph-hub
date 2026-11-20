/** A silent connected lock holder remains untouched and daemon --stop reports it as busy. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeServerLock } from '../../../src/mcp/daemon-paths';
import { isProcessAlive, readServerLock, stopServer } from '../../../src/mcp/server-control';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { stateIdentityOf } from './state-identity';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
let stateDir: string;
let savedStateDir: string | undefined;
let child: ChildProcess | null = null;

async function startSilentHolder() {
  const socketPath = path.join(stateDir, 'server.sock');
  const source = [
    "const net = require('net');",
    "net.createServer((c) => { c.on('error', () => {}); }).listen(process.argv[1], () => console.log('ready'));",
  ].join('\n');
  const holder = spawn(process.execPath, ['-e', source, socketPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  child = holder;
  if (holder.pid === undefined || holder.stdout === null) throw new Error('stand-in server did not start');
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.once('exit', () => reject(new Error('stand-in server exited before listening')));
    holder.stdout?.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
  });
  const lock = {
    pid: holder.pid,
    version: CodeGraphPackageVersion,
    socketPath,
    startedAt: Date.now(),
    stateDir,
    stateId: stateIdentityOf(stateDir),
  };
  fs.writeFileSync(path.join(stateDir, 'server.pid'), encodeServerLock(lock));
  return { holder, lock };
}

beforeEach(() => {
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stop-busy-')));
  process.env.CODEGRAPH_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const holder = child;
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.kill('SIGKILL');
    await exited;
  }
  child = null;
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('stopping a silent connected holder', () => {
  // slow: starts a child and waits for the hello timeout on a heavily loaded machine.
  it('returns busy without signalling the holder or changing its lock', async () => {
    const { holder, lock } = await startSilentHolder();
    const result = await stopServer({ graceMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isProcessAlive(lock.pid)).toBe(true);
    expect(holder.signalCode).toBeNull();
    expect(readServerLock()).toEqual(lock);
    expect(result).toEqual({ outcome: 'busy', pid: lock.pid, version: lock.version });
  }, 90_000);

  // slow: spawns the built CLI and a holder, then waits for the hello timeout under heavy load.
  it('daemon --stop reports busy without suggesting lock deletion or signalling the holder', async () => {
    const { holder, lock } = await startSilentHolder();
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(process.execPath, [BIN, 'daemon', '--stop'], {
        encoding: 'utf8',
        env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_STATE_DIR: stateDir },
      }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: stdout + stderr });
      });
    });
    expect(result.code).toBe(1);
    expect(isProcessAlive(lock.pid)).toBe(true);
    expect(holder.signalCode).toBeNull();
    expect(result.output).toContain('running but busy');
    expect(result.output).toContain('Retry `codegraph daemon --stop` in a moment, or wait for it to finish.');
    expect(result.output).not.toContain('server.pid');
  }, 90_000);
});
