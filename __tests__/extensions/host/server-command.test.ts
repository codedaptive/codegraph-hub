/**
 * `codegraph daemon [--stop]`: shows the one
 * machine server of the state dir, or stops it. Non-interactive, no picker.
 *
 * Runs the BUILT binary (dist/bin/codegraph.js) against a stand-in server: a node
 * child that binds the state dir's socket and answers the hello with its own pid,
 * which is what the command's identity proof (src/mcp/server-control.ts) asks
 * for. Each test has its own CODEGRAPH_STATE_DIR, so the live server of
 * `~/.codegraph` is never reached.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stateIdentityOf } from './state-identity';
import { encodeServerLock } from '../../../src/mcp/daemon-paths';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

let stateDir: string;
let child: ChildProcess | null = null;

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_STATE_DIR: stateDir, ...env },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

/** Bind the state dir's socket in a child that answers the hello as `version`, and write its lock. */
async function startStandInServer(version: string): Promise<number> {
  const socketPath = path.join(stateDir, 'server.sock');
  const source = [
    "const net = require('net');",
    'const [sock, version] = process.argv.slice(1);',
    'net.createServer((c) => {',
    "  c.on('error', () => {});",
    "  c.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath: sock, protocol: 1 }) + '\\n');",
    "}).listen(sock, () => console.log('ready'));",
  ].join('\n');
  child = spawn(process.execPath, ['-e', source, socketPath, version], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child!.once('error', reject);
    child!.once('exit', () => reject(new Error('stand-in server exited before listening')));
    child!.stdout!.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
  });
  fs.writeFileSync(path.join(stateDir, 'server.pid'), encodeServerLock({
    pid: child.pid!, version, socketPath, startedAt: Date.now() - 65_000, stateDir, stateId: stateIdentityOf(stateDir),
  }));
  return child.pid!;
}

beforeEach(() => {
  // Realpath'd: the lock records the canonical state dir (os.tmpdir() is a symlink on some systems).
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-daemon-cmd-')));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  child = null;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('codegraph daemon', () => {
  it('says so when no server runs in this state dir', async () => {
    const result = await run(['daemon']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No CodeGraph server running.');
  });

  it('shows the one server: pid, version, uptime, socket and state dir', async () => {
    const pid = await startStandInServer(CodeGraphPackageVersion);
    const result = await run(['daemon']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`pid ${pid}`);
    expect(result.stdout).toContain(`v${CodeGraphPackageVersion}`);
    expect(result.stdout).toMatch(/up 1m/);
    expect(result.stdout).toContain(`socket: ${path.join(stateDir, 'server.sock')}`);
    expect(result.stdout).toContain(`state dir: ${stateDir}`);
    expect(isProcessAlive(pid)).toBe(true);
  });

  // Own timeout. It runs two CLI invocations (each re-execs the built CLI once) and a
  // stand-in server. Measured on 18 CPUs at 1-minute load average ~106-115: 20.5 s alone;
  // 23.0-26.6 s with four copies at load ~101-108. Re-measured after the exit wait below:
  // 18.8-20.6 s. The 90 s limit is about three times the slowest run measured across these
  // tests (32.0 s).
  it('--stop stops it, verified by its hello, and a second --stop finds none', async () => {
    const pid = await startStandInServer(CodeGraphPackageVersion);
    // The stand-in is this test's own child, so its 'exit' event shows it has exited;
    // the stdout check below ties that exit to --stop. Attach before --stop runs; skip
    // the wait if it already exited.
    const stand = child!;
    const exited = stand.exitCode !== null || stand.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => stand.once('exit', () => resolve()));
    const result = await run(['daemon', '--stop']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Stopped the CodeGraph server (pid ${pid}`);
    // The wait is on the event; the test timeout bounds it.
    await exited;
    expect(isProcessAlive(pid)).toBe(false);
    const again = await run(['daemon', '--stop']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('No CodeGraph server running.');
  }, 90_000);

  it('--stop leaves a process alone that holds the lock but does not answer as the server', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child = stranger;
    fs.writeFileSync(path.join(stateDir, 'server.pid'), encodeServerLock({
      pid: stranger.pid!, version: CodeGraphPackageVersion, socketPath: path.join(stateDir, 'server.sock'),
      startedAt: Date.now(), stateDir, stateId: stateIdentityOf(stateDir),
    }));
    const result = await run(['daemon', '--stop']);
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain('did not answer as the CodeGraph server');
    expect(isProcessAlive(stranger.pid!)).toBe(true);
    expect(stranger.signalCode).toBeNull();
  });

  it('refuses a relative CODEGRAPH_STATE_DIR with a clear message', async () => {
    const result = await run(['daemon'], { CODEGRAPH_STATE_DIR: 'relative/state' });
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain('CODEGRAPH_STATE_DIR must be an absolute path');
  });
});
