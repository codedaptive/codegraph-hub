/**
 * The machine server — issue #411.
 *
 * Validates the server architecture in `src/mcp/{daemon,proxy,session,index}.ts`:
 *
 *   - The server is ONE *detached* background process per state directory
 *     (`CODEGRAPH_STATE_DIR`, else `~/.codegraph`); every `serve --mcp`
 *     invocation is a thin proxy to it, whichever repository it was launched
 *     in. Two invocations share ONE server.
 *   - Concurrent launchers converge on a single server: the lockfile appears
 *     already complete, so no racing candidate can read an empty pidfile and
 *     unlink the winner's lock.
 *   - Killing the launcher that spawned the server does NOT take the server
 *     down — other attached clients keep working. The server is detached from
 *     every launcher's process group.
 *   - A stale lockfile (dead pid) is cleared; `CODEGRAPH_NO_DAEMON=1` opts out.
 *     A newer server leaves the session in-process; an older one is replaced.
 *     A session with no server serves in-process, read-only, until one answers
 *     again (#662, #2277).
 *   - The server never exits because it is idle (gate G2 in
 *     extensions/host/machine-server.gate.test.ts), so there is no idle-timeout
 *     case here.
 *
 * These tests intentionally spawn real `node dist/bin/codegraph.js` processes
 * over real sockets/pipes — the same surface a Claude Code / Cursor / Codex
 * install exercises. Every spawn gets its own throwaway state directory, so the
 * live server of this machine is never touched. The server logs to
 * `<state>/server.log` (it has no client stderr of its own), so server-side
 * assertions read that file.
 *
 * `realRoot` vs `tempDir`: processes are spawned with the (possibly symlinked)
 * `tempDir` as cwd — on macOS `os.tmpdir()` lives under `/var`, a symlink to
 * `/private/var`, and a spawned child's `process.cwd()` is already realpath'd.
 * The session's repo anchor is the canonical form, so path assertions use
 * `realRoot`. That this matches end to end is itself the proof the
 * canonicalization works.
 *
 * Tool calls carry `projectPath` (the server has no default project); a call
 * without one is answered with the exact missing-argument text.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getServerSocketPath } from '../src/mcp/daemon-paths';
import { stateIdentityOf } from './extensions/host/state-identity';
import { MISSING_PROJECT_PATH_TEXT } from '../src/extensions/host/server/repo-anchor';
import { once } from 'events';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { SERVER_INFO } from '../src/mcp/session';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

/** The throwaway state directory of the current test; every spawn below gets it. */
let stateDir: string;

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}, args: string[] = []): SpawnedServer {
  // Record the server candidates this launcher spawns, for the teardown.
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp', ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // #618: the daemon-attach log line is now off by default; opt the test
    // harness into it (CODEGRAPH_MCP_LOG_ATTACH=1) so the attach assertions
    // below can still observe a successful attach. A per-test env still wins.
    env: {
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      ...process.env,
      ...recorder.env,
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

/** One `tools/call` that names its project, as every call must. */
function sendToolCall(
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: string,
  projectPath: string,
  args: Record<string, unknown> = {},
): void {
  sendMessage(child, {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: { ...args, projectPath } },
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
        // timeout can't tell WHICH step flaked (the #662 test's recurring
        // timeout was undiagnosable for exactly this reason).
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

function readLockSocket(): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8'));
    return typeof info.socketPath === 'string' ? info.socketPath : null;
  } catch { return null; }
}

function readServerLog(): string {
  try { return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8'); }
  catch { return ''; }
}

function countListeningLines(): number {
  return readServerLog().split('\n').filter((l) => l.includes('[CodeGraph daemon] Listening on')).length;
}

function stampIndexStale(cg: CodeGraph, version: string): void {
  const metadata = cg as unknown as {
    queries: { setMetadata(key: string, value: string): void };
  };
  metadata.queries.setMetadata('indexed_with_version', version);
  metadata.queries.setMetadata(
    'indexed_with_extraction_version',
    String(EXTRACTION_VERSION - 1),
  );
}

function killTree(...procs: ChildProcessWithoutNullStreams[]): void {
  for (const p of procs) {
    if (!p.killed) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs).then(() => true).catch(() => false);
}

async function staleIndex(root: string): Promise<Buffer> {
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() {}\n');
  const cg = CodeGraph.openSync(root);
  try { await cg.indexAll(); } finally { cg.close(); }
  const before = fs.readFileSync(path.join(root, '.codegraph', 'codegraph.db'));
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function changedSymbol() {}\n');
  return before;
}

describe('The machine server', () => {
  let tempDir: string;   // the (possibly symlinked) path processes are spawned with
  let realRoot: string;  // its canonical form — what the session's repo anchor names
  const servers: SpawnedServer[] = [];
  const priorStateDir = process.env.CODEGRAPH_STATE_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-daemon-'));
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-state-')));
    // This process computes the server's socket path with the same helpers the
    // server uses, so it must see the same state dir the children are given.
    process.env.CODEGRAPH_STATE_DIR = stateDir;
    const cg = await CodeGraph.init(tempDir);
    cg.close();
    realRoot = fs.realpathSync(tempDir);
  });

  afterEach(async () => {
    // The runtime flags avoid an intermediate relaunch process. Wait for each
    // actual server to exit before removing its Windows working directory.
    await Promise.all(servers.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    // Racing launchers may each have spawned a server candidate, and a loser
    // can still be starting on a loaded machine. Stopping the winner first
    // would let it take over the fixture being removed (#1773).
    await settleLosingCandidates(tempDir, () => readLockPid());
    // The server is detached (not a tracked child) — reap it explicitly via the
    // pid it recorded, so a test can't leak a background server. Guard against
    // our own pid: a test may plant `pid: process.pid` in the lockfile, and we
    // must never SIGKILL the vitest worker.
    const serverPid = readLockPid();
    if (serverPid && serverPid !== process.pid && isAlive(serverPid)) {
      try { process.kill(serverPid, 'SIGKILL'); } catch { /* race */ }
      await waitProcessExit(serverPid, 5000);
    }
    await new Promise((r) => setTimeout(r, 50));
    servers.length = 0;
    removeSpawnLog(tempDir);
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.promises.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
  }, 45_000);

  it.runIf(process.platform !== 'win32')('stops despite a socket still waiting for its client hello (#1963)', async () => {
    // The 1.5 s window below times only the teardown a hello-waiting socket
    // could block (server.close() waits for every open connection). Two other
    // waits in stop() are deliberate and scale with machine load, so the test
    // keeps them out of the window rather than widening it:
    //   - the query pool: stop waits for a worker still starting up before it
    //     terminates it (WORKER_START_SETTLE_MS in src/mcp/query-pool.ts). The
    //     server starts its first worker right after attach, so a SIGTERM sent
    //     then waits out the rest of that start. CODEGRAPH_QUERY_POOL_SIZE=0
    //     runs no pool.
    //   - the startup catch-up sync, which is the index builder's: releasing
    //     the project waits for the engine's gate on it (ToolHandler's
    //     releaseProjectRoot), and stopping the server waits for the builder
    //     to finish and exit. A tool call waits on that same sync before it
    //     answers, and CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 makes that wait
    //     unbounded, so its reply means the sync is done.
    // Measured on a machine at load 35-41 with both waits in the window: 7 of
    // 10 stops took longer than 1.5 s (up to 2.6 s), while closing the server
    // took 1-3 ms (#1963).
    const server = spawnServer(tempDir, { CODEGRAPH_QUERY_POOL_SIZE: '0', CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS: '0' });
    servers.push(server);
    sendInitialize(server.child, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    // The lock is written before the socket is bound; an attached proxy proves
    // the server is listening (#1773).
    await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
    sendToolCall(server.child, 2, 'codegraph_files', tempDir);
    expect((await waitFor(() => findResponse(server.stdout, 2), 10000)).error).toBeUndefined();
    const pid = await waitFor(() => readLockPid(), 10000);
    const raw = net.connect(getServerSocketPath());
    try {
      await new Promise<void>((resolve, reject) => {
        raw.once('data', () => resolve());
        raw.once('error', reject);
      });
      process.kill(pid, 'SIGTERM');
      expect(await waitProcessExit(pid, 1500)).toBe(true);
      expect(fs.existsSync(path.join(realRoot, '.codegraph', 'writer.pid'))).toBe(false);
    } finally {
      raw.destroy();
    }
  }, 20000);

  it('two invocations share ONE detached server; both attach as proxies', async () => {
    const first = spawnServer(tempDir);
    servers.push(first);
    sendInitialize(first.child, 1);
    const firstResp = await waitFor(() => findResponse(first.stdout, 1), 10000);
    expect(firstResp.result.serverInfo).toEqual(SERVER_INFO);

    // The launcher is a PROXY (not the server itself) — that's the detach fix.
    await waitFor(() => first.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // A detached server came up and recorded itself in the state dir.
    await waitFor(() => fs.existsSync(path.join(stateDir, 'server.pid')), 8000);
    await waitFor(() => countListeningLines() >= 1, 8000);
    const serverPid = readLockPid();
    expect(serverPid).toBeTruthy();
    expect(isAlive(serverPid!)).toBe(true);
    // The socket exists at the path the code computes from the state dir.
    // On Windows the server listens on a named pipe (\\.\pipe\...), which isn't
    // a filesystem entry — existsSync doesn't apply there, and the "Attached to
    // shared daemon" proof above already confirms the proxy reached it.
    if (process.platform !== 'win32') {
      expect(fs.existsSync(getServerSocketPath())).toBe(true);
    }

    // Second invocation attaches as a proxy to the SAME server.
    const second = spawnServer(tempDir);
    servers.push(second);
    sendInitialize(second.child, 2);
    const secondResp = await waitFor(() => findResponse(second.stdout, 2), 10000);
    expect(secondResp.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => second.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // Exactly one server ever bound, and it's the same pid both attached to.
    expect(countListeningLines()).toBe(1);
    expect(readLockPid()).toBe(serverPid);
  }, 40000);

  it('a launch directory with no .codegraph/ still attaches to the machine server', async () => {
    // The server lives under the state dir, not under a project, so there is no
    // "no .codegraph/ here, serve in-process" branch: a session launched in a
    // bare directory is a proxy like any other.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-bare-'));
    try {
      const server = spawnServer(bare);
      servers.push(server);
      sendInitialize(server.child, 1);
      await waitFor(() => findResponse(server.stdout, 1), 10000);
      await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
      expect(isAlive(readLockPid()!)).toBe(true);
      expect(fs.existsSync(path.join(bare, '.codegraph'))).toBe(false);
    } finally {
      killTree(...servers.map((s) => s.child));
      await settleLosingCandidates(bare, () => readLockPid());
      removeSpawnLog(bare);
      fs.rmSync(bare, { recursive: true, force: true });
    }
  }, 30000);

  // The stale-index warning (#1852) through the machine server: every call names
  // its projectPath, and one server answers every proxy, each a client of its own.
  it('warns once per proxied client when the shared project index is stale (#1852)', async () => {
    fs.writeFileSync(path.join(tempDir, 'alpha.ts'), 'export function alpha() { return 1; }\n');
    const indexed = await CodeGraph.open(tempDir);
    await indexed.indexAll();
    stampIndexStale(indexed, '0.1.0');
    indexed.close();

    const first = spawnServer(tempDir);
    const second = spawnServer(tempDir);
    servers.push(first, second);
    sendInitialize(first.child, 1);
    sendInitialize(second.child, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => findResponse(second.stdout, 1), 10000);
    await waitFor(() => first.stderr.some((line) => line.includes('Attached to shared daemon')), 8000);
    await waitFor(() => second.stderr.some((line) => line.includes('Attached to shared daemon')), 8000);

    const responseText = (response: any): string => response.result.content[0].text;

    sendToolCall(first.child, 2, 'codegraph_search', tempDir, { query: 'alpha' });
    const firstInitial = await waitFor(() => findResponse(first.stdout, 2), 10000);

    sendToolCall(first.child, 3, 'codegraph_search', tempDir, { query: 'alpha' });
    sendToolCall(second.child, 2, 'codegraph_search', tempDir, { query: 'alpha' });
    const firstRepeat = await waitFor(() => findResponse(first.stdout, 3), 10000);
    const secondInitial = await waitFor(() => findResponse(second.stdout, 2), 10000);

    expect(responseText(firstInitial)).toMatch(/index predates the running extraction engine/i);
    expect(responseText(firstRepeat)).not.toMatch(/index predates/i);
    expect(responseText(secondInitial)).toMatch(/index predates the running extraction engine/i);
    expect(countListeningLines()).toBe(1);
  }, 45000);

  it('does not repeat a server-delivered warning after proxy failover (#1852)', async () => {
    fs.writeFileSync(path.join(tempDir, 'alpha.ts'), 'export function alpha() { return 1; }\n');
    const indexed = await CodeGraph.open(tempDir);
    await indexed.indexAll();
    stampIndexStale(indexed, '0.1.0');
    indexed.close();

    const otherRoot = path.join(tempDir, 'other');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'bravo.ts'), 'export function bravo() { return 2; }\n');
    const other = await CodeGraph.init(otherRoot, { index: false });
    await other.indexAll();
    stampIndexStale(other, '0.2.0');
    other.close();

    const server = spawnServer(tempDir, { CODEGRAPH_PPID_POLL_MS: '5000' });
    servers.push(server);
    sendInitialize(server.child, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((line) => line.includes('Attached to shared daemon')), 8000);
    await waitFor(() => (readLockPid() ?? 0) > 0, 8000);
    const serverPid = readLockPid()!;

    sendToolCall(server.child, 2, 'codegraph_search', tempDir, { query: 'alpha' });
    const throughServer = await waitFor(() => findResponse(server.stdout, 2), 10000);
    expect(throughServer.result.content[0].text).toMatch(/index predates/i);

    process.kill(serverPid, 'SIGTERM');
    expect(await waitProcessExit(serverPid, 8000)).toBe(true);
    await waitFor(
      () => server.stderr.some((line) => line.includes('serving this session in-process')),
      8000,
    );

    sendToolCall(server.child, 3, 'codegraph_search', tempDir, { query: 'alpha' });
    const afterFailover = await waitFor(() => findResponse(server.stdout, 3), 10000);
    expect(afterFailover.result.content[0].text).not.toMatch(/index predates/i);

    sendToolCall(server.child, 4, 'codegraph_search', otherRoot, { query: 'bravo' });
    const otherProject = await waitFor(() => findResponse(server.stdout, 4), 10000);
    expect(otherProject.result.content[0].text).toMatch(/index predates/i);
    expect(otherProject.result.content[0].text).toContain('CodeGraph v0.2.0');
  }, 45000);

  it('concurrent launchers converge on a single server (the lock appears complete, never empty)', async () => {
    // Fire three launchers as close to simultaneously as possible — this is the
    // race window where the old code could end up with two servers.
    const procs = [spawnServer(tempDir), spawnServer(tempDir), spawnServer(tempDir)];
    procs.forEach((p, i) => { servers.push(p); sendInitialize(p.child, i + 1); });

    // All three get a valid initialize response...
    for (let i = 0; i < procs.length; i++) {
      const resp = await waitFor(() => findResponse(procs[i].stdout, i + 1), 12000);
      expect(resp.result.serverInfo.name).toBe('codegraph');
    }
    // ...and all three attached as proxies (none fell back / wedged).
    for (const p of procs) {
      await waitFor(() => p.stderr.some((l) => l.includes('Attached to shared daemon')), 10000);
    }

    // The decisive assertion: exactly ONE server bound the socket. Losing
    // candidates log "already holds the lock; exiting" and never listen.
    expect(countListeningLines()).toBe(1);
    const serverPid = readLockPid();
    expect(serverPid).toBeTruthy();
    expect(isAlive(serverPid!)).toBe(true);
  }, 45000);

  it('server survives the first client dying; a second client keeps working (#277)', async () => {
    // Poll fast so proxy 1 notices its dead parent quickly.
    const env = { CODEGRAPH_PPID_POLL_MS: '200' };

    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    await waitFor(() => (readLockPid() ?? 0) > 0, 8000);
    const serverPid = readLockPid()!;
    expect(isAlive(serverPid)).toBe(true);

    const second = spawnServer(tempDir, env);
    servers.push(second);
    sendInitialize(second.child, 1);
    await waitFor(() => findResponse(second.stdout, 1), 10000);
    await waitFor(() => second.stderr.some((l) => l.includes('Attached to shared daemon')), 8000);

    // Kill the launcher that spawned the server. With the old in-process design
    // this would take the server (and thus the second client) down.
    killTree(first.child);

    // The server is detached — it must still be alive a beat later.
    await new Promise((r) => setTimeout(r, 1500));
    expect(isAlive(serverPid)).toBe(true);

    // And the second client can still drive a real tool call through it.
    sendMessage(second.child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolsResp = await waitFor(() => findResponse(second.stdout, 2), 10000);
    expect(Array.isArray(toolsResp.result.tools)).toBe(true);
    expect(toolsResp.result.tools.length).toBeGreaterThan(0);
  }, 45000);

  it('CODEGRAPH_NO_DAEMON=1 keeps each process independent (no socket/pidfile)', async () => {
    const env = { CODEGRAPH_NO_DAEMON: '1' };
    const first = spawnServer(tempDir, env);
    servers.push(first);
    sendInitialize(first.child, 1);
    await waitFor(() => findResponse(first.stdout, 1), 10000);
    // Direct mode — no server machinery touched.
    expect(first.stderr.some((l) => l.includes('Attached to shared daemon'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'server.pid'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'server.log'))).toBe(false);
  }, 20000);

  it.each(['2', '0'])('direct stdio honors query pool size=%s and exits after concurrent reads', async (size) => {
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export function directSymbol() { return 42; }\n');
    const cg = await CodeGraph.open(tempDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    const server = spawnServer(tempDir, {
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_QUERY_POOL_SIZE: size,
    }, ['--no-watch', '--path', tempDir]);
    servers.push(server);
    sendInitialize(server.child, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((l) => l.includes(size === '0'
      ? 'Query pool disabled' : 'Query pool: up to 2 worker thread(s)')), 10000, 25, 'direct query pool configuration');
    const ids = [2, 3, 4, 5, 6, 7];
    for (const id of ids) {
      sendToolCall(server.child, id, 'codegraph_explore', tempDir, { query: 'directSymbol' });
    }
    const replies = await Promise.all(ids.map((id) => waitFor(() => findResponse(server.stdout, id), 15000)));
    for (const reply of replies) {
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).toBeFalsy();
      expect(reply.result.content[0].text).toContain('directSymbol');
      expect(reply.result).not.toHaveProperty('_cgExploreEmission');
    }
    const exited = new Promise<number | null>((resolve) => server.child.once('exit', resolve));
    server.child.stdin.end();
    expect(await exited).toBe(0);
  }, 30000);

  it('direct stdio answers for its launch repository only; a second repository is refused by the anchor', async () => {
    // Two indexed projects side by side, no index at the parent. The session is
    // launched in `alpha`: that fixes its repo anchor, so `beta` is outside it
    // and gets guidance naming the anchor — never an error — while a call that
    // names no project gets the exact missing-argument text.
    fs.rmSync(path.join(tempDir, '.codegraph'), { recursive: true, force: true });
    for (const name of ['alpha', 'beta']) {
      const root = path.join(tempDir, name);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'app.ts'), `export function ${name}Symbol() { return 42; }\n`);
      const cg = await CodeGraph.init(root);
      try { await cg.indexAll(); } finally { cg.close(); }
    }
    const alpha = path.join(tempDir, 'alpha');
    const server = spawnServer(alpha, {
      CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_QUERY_POOL_SIZE: '2',
    }, ['--no-watch', '--path', alpha]);
    servers.push(server);
    sendInitialize(server.child, 1);
    await waitFor(() => findResponse(server.stdout, 1), 10000);
    await waitFor(() => server.stderr.some((l) => l.includes('Query pool: up to 2')), 10000);

    sendToolCall(server.child, 2, 'codegraph_explore', alpha, { query: 'alphaSymbol' });
    const own = await waitFor(() => findResponse(server.stdout, 2), 15000);
    expect(own.result.isError).toBeFalsy();
    expect(own.result.content[0].text).toContain('alphaSymbol');

    sendToolCall(server.child, 3, 'codegraph_explore', path.join(tempDir, 'beta'), { query: 'betaSymbol' });
    const refused = await waitFor(() => findResponse(server.stdout, 3), 15000);
    expect(refused.result.isError).toBeFalsy();
    expect(refused.result.content[0].text).toContain(path.join(realRoot, 'alpha'));
    expect(refused.result.content[0].text).not.toContain('betaSymbol');

    sendMessage(server.child, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'alphaSymbol' } },
    });
    const missing = await waitFor(() => findResponse(server.stdout, 4), 10000);
    expect(missing.result.isError).toBeFalsy();
    expect(missing.result.content[0].text).toBe(MISSING_PROJECT_PATH_TEXT);
    expect(fs.existsSync(path.join(tempDir, '.codegraph'))).toBe(false);
  }, 30000);

  it('clears a stale (dead-pid) lockfile and a fresh server takes over', async () => {
    // Plant a lockfile pointing at a definitely-dead pid + the real socket path.
    fs.writeFileSync(
      path.join(stateDir, 'server.pid'),
      JSON.stringify({
        pid: 999_999,
        version: '0.0.0-fake',
        socketPath: getServerSocketPath(),
        startedAt: Date.now() - 1000,
        stateDir,
        stateId: stateIdentityOf(stateDir),
      }),
    );

    const server = spawnServer(tempDir);
    servers.push(server);
    sendInitialize(server.child, 1);
    const resp = await waitFor(() => findResponse(server.stdout, 1), 10000).catch((e) => {
      throw new Error(`${(e as Error).message}\nstderr:\n${server.stderr.join('\n')}\nserver.log:\n${readServerLog()}`);
    });
    expect(resp.result.serverInfo.name).toBe('codegraph');
    await waitFor(() => countListeningLines() >= 1, 10000);
    // The pidfile now names a live server, not the planted-dead 999999.
    const livePid = readLockPid();
    expect(livePid).not.toBe(999_999);
    expect(isAlive(livePid!)).toBe(true);
  }, 40000);

  it.each([null, 'fallback'])('proxy falls back to read-only mode on a server version mismatch (live writer: %s)', async (mode) => {
    // The mismatched server answers on the machine socket, so this session is
    // served in-process. That engine is read-only: it claims no writer slot and
    // writes no index, whether or not another process owns the project's writer
    // lock, so the planted writer record and the database stay byte-identical.
    const before = await staleIndex(realRoot);
    const writerPath = path.join(realRoot, '.codegraph', 'writer.pid');
    const writer = JSON.stringify({ pid: process.pid, mode, startedAt: Date.now() });
    if (mode) fs.writeFileSync(writerPath, writer);
    const sockPath = getServerSocketPath();
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({
        codegraph: '0.0.0-mismatch',
        pid: process.pid,
        socketPath: sockPath,
        protocol: 1,
      }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));

    try {
      const server = spawnServer(tempDir);
      servers.push(server);
      sendInitialize(server.child, 1);
      // Despite the mismatched server, the client still gets an initialize
      // response — the proxy answers the handshake locally and, refusing to
      // attach across the version mismatch, serves the session in-process.
      const resp = await waitFor(() => findResponse(server.stdout, 1), 10000);
      expect(resp.result.serverInfo.name).toBe('codegraph');
      await waitFor(
        () => server.stderr.some((l) => l.includes('serving this session in-process')),
        6000,
      );

      sendToolCall(server.child, 2, 'codegraph_status', tempDir);
      const toolResponse = await waitFor(() => findResponse(server.stdout, 2), 5000);
      expect(toolResponse.error).toBeUndefined();
      expect(toolResponse.result?.isError).not.toBe(true);
      expect(JSON.stringify(toolResponse.result)).toContain('CodeGraph Status');
      expect(fs.existsSync(writerPath)).toBe(mode !== null);
      expect(server.stderr.some((l) => l.includes('Serving reads in-process without auto-sync:'))).toBe(true);
      server.child.stdin.end();
      await waitFor(() => server.child.exitCode !== null, 5000);
      expect(fs.readFileSync(path.join(realRoot, '.codegraph', 'codegraph.db'))).toEqual(before);
      if (mode) expect(fs.readFileSync(writerPath, 'utf8')).toBe(writer);
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 30000);

  it('the in-process fallback answers through the repo anchor: no projectPath gets the exact text, an outside path guidance', async () => {
    const sockPath = getServerSocketPath();
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({
        codegraph: '0.0.0-mismatch', pid: process.pid, socketPath: sockPath, protocol: 1,
      }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-outside-'));
    try {
      const server = spawnServer(tempDir);
      servers.push(server);
      sendInitialize(server.child, 1);
      await waitFor(() => server.stderr.some((l) => l.includes('serving this session in-process')), 10000);

      sendMessage(server.child, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'codegraph_status', arguments: {} },
      });
      const missing = await waitFor(() => findResponse(server.stdout, 2), 10000);
      expect(missing.result.isError).toBeFalsy();
      expect(missing.result.content[0].text).toBe(MISSING_PROJECT_PATH_TEXT);

      sendToolCall(server.child, 3, 'codegraph_status', outside);
      const refused = await waitFor(() => findResponse(server.stdout, 3), 10000);
      expect(refused.result.isError).toBeFalsy();
      expect(refused.result.content[0].text).toContain(realRoot);
    } finally {
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30000);

  it('proxy survives the server dying mid-session and keeps serving (#662)', async () => {
    // The #662 scenario: an MCP host SIGTERM's the shared server while a session
    // is live. The proxy must NOT exit (losing CodeGraph for that session) — it
    // falls back to an in-process engine and keeps answering.
    const env = { CODEGRAPH_PPID_POLL_MS: '5000' };
    const server = spawnServer(tempDir, env);
    servers.push(server);
    sendInitialize(server.child, 1);
    await waitFor(() => findResponse(server.stdout, 1), 20000, 25, 'initialize response');
    await waitFor(() => server.stderr.some((l) => l.includes('Attached to shared daemon')), 8000, 25, 'server attach log');
    await waitFor(() => (readLockPid() ?? 0) > 0, 8000, 25, 'server pidfile');
    const serverPid = readLockPid()!;

    // A warm call goes through the server.
    sendToolCall(server.child, 2, 'codegraph_status', tempDir);
    try {
      await waitFor(() => findResponse(server.stdout, 2), 30000, 25, 'warm tools/call via server');
    } catch (e) {
      // This is the wait that historically flaked — surface WHERE the request
      // died: proxy side (stderr) or server side (server.log).
      const serverLog = readServerLog().split('\n').slice(-25).join('\n') || '<no server.log>';
      throw new Error(
        `${(e as Error).message}\nserverAlive=${isAlive(serverPid)} proxyAlive=${isAlive(server.child.pid!)}\n` +
        `--- proxy stderr tail ---\n${server.stderr.slice(-15).join('')}\n--- server.log tail ---\n${serverLog}`
      );
    }

    // Kill the server out from under the live proxy.
    process.kill(serverPid, 'SIGTERM');
    expect(await waitProcessExit(serverPid, 8000)).toBe(true);

    // The proxy must still be alive and still answer — served in-process now.
    expect(isAlive(server.child.pid!)).toBe(true);
    await waitFor(() => server.stderr.some((l) => l.includes('serving this session in-process')), 8000, 25, 'in-process failover log');
    sendToolCall(server.child, 3, 'codegraph_status', tempDir);
    const resp = await waitFor(() => findResponse(server.stdout, 3), 15000);
    expect(resp.result !== undefined || resp.error !== undefined).toBe(true);
    expect(isAlive(server.child.pid!)).toBe(true);
  }, 45000);

  it('a session served in-process moves to the machine server once one can start (#2277)', async () => {
    // A session that fell back in-process (a server of another version held the
    // socket) used to stay that way for life. Once the blocker is gone the
    // proxy's retry starts a server of its own version, attaches to it, and
    // stops its fallback engine.
    const sockPath = getServerSocketPath();
    const miniServer = net.createServer((sock) => {
      sock.write(JSON.stringify({ codegraph: '0.0.0-mismatch', pid: process.pid, socketPath: sockPath, protocol: 1 }) + '\n');
    });
    await new Promise<void>((resolve) => miniServer.listen(sockPath, () => resolve()));
    let miniServerOpen = true;
    try {
      const server = spawnServer(tempDir, {
        CODEGRAPH_DAEMON_RETRY_MS: '300',
        CODEGRAPH_DAEMON_RETRY_MAX_MS: '1000',
      });
      servers.push(server);
      sendInitialize(server.child, 1);
      await waitFor(() => server.stderr.some((l) => l.includes('serving this session in-process')), 10000, 25, 'in-process fallback');
      sendToolCall(server.child, 2, 'codegraph_status', tempDir);
      const local = await waitFor(() => findResponse(server.stdout, 2), 10000, 25, 'read-only tools/call');
      expect(local.error).toBeUndefined();
      expect(server.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(true);
      // Retries while the other version still answers start no server.
      await waitFor(
        () => server.stderr.filter((l) => l.includes('differs from ours')).length >= 3,
        10000, 25, 'repeated retries against the other version',
      );
      expect(countListeningLines()).toBe(0);

      // The other-version server goes away.
      await new Promise<void>((resolve) => miniServer.close(() => resolve()));
      miniServerOpen = false;

      const attached = await waitFor(
        () => server.stderr.find((l) => l.includes('Attached to shared daemon')),
        30000, 25, 'the session to attach to a server',
      );
      const serverPid = readLockPid()!;
      expect(attached).toContain(`(pid ${serverPid},`);
      expect(server.stderr.some((l) => l.includes('proxying this session to it instead of serving in-process'))).toBe(true);
      sendToolCall(server.child, 3, 'codegraph_status', tempDir);
      const viaServer = await waitFor(() => findResponse(server.stdout, 3), 15000, 25, 'tools/call through the server');
      expect(viaServer.error).toBeUndefined();
      expect(JSON.stringify(viaServer.result)).toContain('CodeGraph Status');
    } finally {
      if (miniServerOpen) await new Promise<void>((resolve) => miniServer.close(() => resolve()));
    }
  }, 60000);
});
