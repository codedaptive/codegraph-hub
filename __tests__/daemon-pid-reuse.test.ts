// Preserve successful PID-reuse recovery alongside the live-lock guards in #1850.
/**
 * Machine server — PID reuse after SIGKILL (#1553).
 *
 * A SIGKILL'd server leaves `<state>/server.pid` behind, and the OS may hand
 * its pid to an unrelated live process. A bare "is that pid alive" check would
 * then defer to the unrelated process forever and no server would ever start.
 * The next launcher's candidate therefore requires the lock holder's socket
 * hello to name the lock's pid and version, and clears a record whose holder
 * does not answer as the server (`clearStaleDaemonLock` with `allowLivePid`).
 *
 * The test spawns real `node dist/bin/codegraph.js` processes over real
 * sockets/pipes, with a throwaway state dir so the live server of this machine
 * is never touched. The server logs to `<state>/server.log`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getServerSocketPath } from '../src/mcp/daemon-paths';
import { stateIdentityOf } from './extensions/host/state-identity';
import { CodeGraphPackageVersion } from '../src/mcp/version';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

/** The throwaway state directory of the current test. */
let stateDir: string;

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}): SpawnedServer {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // #618: the daemon-attach log line is now off by default; opt the test
    // harness into it (CODEGRAPH_MCP_LOG_ATTACH=1) so the attach assertions
    // below can still observe a successful attach. A per-test env still wins.
    env: {
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      ...process.env,
      CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
      CODEGRAPH_STATE_DIR: stateDir,
      ...env,
    },
  }) as ChildProcessWithoutNullStreams;
  // Swallow spawn/EPIPE errors so killing a child mid-write can't surface as an
  // unhandled error that crashes the vitest worker.
  child.on('error', () => { /* ignore */ });
  child.stdin.on('error', () => { /* ignore */ });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      stdout.push(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      stderr.push(stderrBuf.slice(0, idx));
      stderrBuf = stderrBuf.slice(idx + 1);
    }
  });
  return { child, stdout, stderr };
}

function sendMessage(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child may be gone */ }
}

function sendInitialize(child: ChildProcessWithoutNullStreams, id: number): void {
  sendMessage(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    },
  });
}

/** Find a JSON-RPC response with the given id (result OR error) on stdout. */
function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  pollMs = 25,
  label = '',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v: T | undefined | null | false;
      try { v = predicate(); } catch (e) { return reject(e); }
      if (v) return resolve(v as T);
      if (Date.now() - started > timeoutMs) {
        // Name the wait: an async stack loses the await site, so an unlabeled
        // timeout can't tell WHICH step flaked.
        return reject(new Error(`Timed out after ${timeoutMs}ms${label ? ` waiting for: ${label}` : ''}`));
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLockPid(): number | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8');
    const info = JSON.parse(raw);
    return typeof info.pid === 'number' ? info.pid : null;
  } catch { return null; }
}

function readServerLog(): string {
  try { return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8'); }
  catch { return ''; }
}

function countListeningLines(): number {
  return readServerLog().split('\n').filter((l) => l.includes('[CodeGraph daemon] Listening on')).length;
}

function killTree(...procs: ChildProcessWithoutNullStreams[]): void {
  for (const p of procs) {
    if (!p.killed) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs).then(() => true).catch(() => false);
}

describe('Machine server PID reuse (#1553)', () => {
  let tempDir: string;
  const servers: SpawnedServer[] = [];
  const priorStateDir = process.env.CODEGRAPH_STATE_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-daemon-'));
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-state-')));
    // This process computes the server's socket path with the helpers the
    // server uses, so it must see the state dir the children are given.
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    const cg = await CodeGraph.init(tempDir);
    cg.close();
  });

  afterEach(async () => {
    killTree(...servers.map((s) => s.child));
    // The server is detached (not a tracked child) — reap it explicitly via the
    // pid it recorded, so a test can't leak a background server. Guard against
    // our own pid: the test plants `pid: process.pid` in the lockfile, and we
    // must never SIGKILL the vitest worker.
    const serverPid = readLockPid();
    if (serverPid && serverPid !== process.pid && isAlive(serverPid)) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* race */ }
    }
    await new Promise((r) => setTimeout(r, 50));
    servers.length = 0;
    // A killed process releases its handles asynchronously on Windows; under
    // full-suite load 50 ms is not always enough, so retry EPERM/EBUSY.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
  });

  it('takes over after SIGKILL even when the stale PID has been reused (#1553)', async () => {
    const first = spawnServer(tempDir);
    servers.push(first);
    sendInitialize(first.child, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => countListeningLines() >= 1, 10000);
    const killedPid = readLockPid()!;

    process.kill(killedPid, 'SIGKILL');
    expect(await waitProcessExit(killedPid, 8000)).toBe(true);

    // Model OS PID reuse without risking another process: the stale lock now
    // names this live vitest worker, but no server answers the leftover socket.
    fs.writeFileSync(
      path.join(stateDir, 'server.pid'),
      JSON.stringify({
        pid: process.pid,
        version: CodeGraphPackageVersion,
        socketPath: getServerSocketPath(),
        startedAt: Date.now() - 60_000,
        stateDir,
        stateId: stateIdentityOf(stateDir),
      }),
    );

    const second = spawnServer(tempDir);
    servers.push(second);
    sendInitialize(second.child, 2);
    const response = await waitFor(() => findResponse(second.stdout, 2), 12000);
    expect(response.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => countListeningLines() >= 2, 10000);

    const replacementPid = readLockPid()!;
    expect(replacementPid).not.toBe(killedPid);
    expect(replacementPid).not.toBe(process.pid);
    expect(isAlive(replacementPid)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  }, 50000);

});
