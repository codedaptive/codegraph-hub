/**
 * `server/discover` probe regression tests (issue #2084).
 *
 * Newer MCP clients (Antigravity 2.5) send `server/discover` before the legacy
 * `initialize` and wait for the answer. A legacy server is expected to reply
 * `-32601 Method not found`, which sends the client on to `initialize`. The
 * stdio proxy forwarded the probe to the shared daemon instead, so nothing was
 * written until the daemon connected: a client that closed stdin first got no
 * reply at all, and with the daemon unavailable the reply came ~6s later as a
 * `-32603` the client can't read as "use initialize".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { encodeServerLock } from '../src/mcp/daemon-paths';
import { stateIdentityOf } from './extensions/host/state-identity';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates, spawnLogFor } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const DISCOVER = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) + '\n';

/** The pid in the machine server's lock (`<state dir>/server.pid`), or null. */
function readLockPid(stateDir: string): number | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8'));
    return typeof info === 'number' ? info : typeof info.pid === 'number' ? info.pid : null;
  } catch { return null; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Send one `server/discover` line and resolve with everything the server wrote
 * to stdout once it has exited. `closeStdin: 'at-once'` is the shape of the
 * `printf … | codegraph serve --mcp` repro; `'after-reply'` is a client that
 * waits for the answer (stdin is closed on the first stdout line).
 */
async function discover(
  cwd: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  children: ChildProcessWithoutNullStreams[],
  closeStdin: 'at-once' | 'after-reply' = 'at-once',
): Promise<string> {
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp', '--no-watch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...recorder.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1', CODEGRAPH_STATE_DIR: stateDir, ...env },
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  child.on('error', () => { /* ignore */ });
  child.stdin.on('error', () => { /* ignore */ });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (closeStdin === 'after-reply' && stdout.includes('\n')) child.stdin.end();
  });
  child.stderr.resume();
  const exited = once(child, 'exit');
  if (closeStdin === 'at-once') child.stdin.end(DISCOVER);
  else child.stdin.write(DISCOVER);
  await exited;
  return stdout;
}

function expectMethodNotFound(stdout: string): void {
  const replies = stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  expect(replies).toEqual([
    { jsonrpc: '2.0', id: 1, error: expect.objectContaining({ code: -32601 }) },
  ]);
}

describe('server/discover probe (issue #2084)', () => {
  let tempDir: string;
  // Each test's own machine-server state dir: the live server is never reached.
  let stateDir: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-discover-'));
    // Realpath'd: the lock records the canonical state dir (os.tmpdir() is a symlink on some systems).
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-discover-state-')));
  });

  afterEach(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    children.length = 0;
    // The proxy spawns a detached daemon candidate; wait for the losers, then
    // stop the lock holder — never the vitest worker, which one test plants as
    // the holder.
    if (fs.existsSync(spawnLogFor(tempDir))) {
      await settleLosingCandidates(tempDir, () => readLockPid(stateDir));
      const daemonPid = readLockPid(stateDir);
      if (daemonPid && daemonPid !== process.pid && isAlive(daemonPid)) {
        try { process.kill(daemonPid, 'SIGKILL'); } catch { /* race */ }
        for (let i = 0; i < 100 && isAlive(daemonPid); i++) await new Promise((r) => setTimeout(r, 50));
      }
      removeSpawnLog(tempDir);
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.promises.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 45_000);

  it.each([
    ['an indexed project', true],
    ['a directory with no .codegraph/', false],
  ])('proxy mode answers -32601 even when the client closes stdin right after the probe (%s)', async (_label, indexed) => {
    if (indexed) {
      const cg = await CodeGraph.init(tempDir);
      cg.close();
    }
    expectMethodNotFound(await discover(tempDir, stateDir, {}, children));
  }, 20_000);

  it('proxy mode answers -32601, not "daemon unavailable", when the server cannot start', async () => {
    const cg = await CodeGraph.init(tempDir);
    cg.close();
    // A lock held by a live process (this worker) that answers no socket hello
    // makes every server candidate step aside, so the proxy never gets a server.
    fs.writeFileSync(path.join(stateDir, 'server.pid'), encodeServerLock({
      pid: process.pid,
      version: 'test',
      socketPath: path.join(stateDir, 'nothing-listens.sock'),
      startedAt: Date.now(),
      stateDir,
      stateId: stateIdentityOf(stateDir),
    }));
    expectMethodNotFound(await discover(tempDir, stateDir, {}, children, 'after-reply'));
  }, 20_000);

  it('direct mode answers -32601 (CODEGRAPH_NO_DAEMON=1 on an indexed project)', async () => {
    const cg = await CodeGraph.init(tempDir);
    cg.close();
    expectMethodNotFound(await discover(tempDir, stateDir, { CODEGRAPH_NO_DAEMON: '1' }, children));
  }, 20_000);
});
