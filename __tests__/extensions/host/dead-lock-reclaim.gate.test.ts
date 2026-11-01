/**
 * Dead-lock reclaim gates: killing the index builder mid-write (the process
 * that holds every writer lock of its server) leaves no lock that blocks the
 * next query, and
 * nobody runs `codegraph unlock`.
 *
 * A dead holder's locks are reclaimed already (G-L2 guards that). What still
 * blocks is pid reuse: the killed builder's pid now names an unrelated live
 * process. G-L1 (direct mode) and G-L3 (machine-server mode) model it on POSIX
 * by moving ONLY the pid in each leftover record onto a live `sleep 600`
 * (fixtures/dead-lock-helpers.ts reusePid); everything else, the recorded
 * start time included, stays what the dead holder wrote. The records come
 * from the real code: the killed builder's own writer.pid / <state>/server.pid,
 * and a victim process (fixtures/dead-lock-victim.ts) that takes rebuild.pid and
 * codegraph.lock through src and is SIGKILL'd holding them.
 *
 * The servers are `node dist/bin/codegraph.js`, the surface an agent
 * install runs, so dist must be built from the code under test: the first
 * test refuses a dist older than the lock sources (`npm run build`).
 *
 * Each test spawns two real servers and a victim (node on fixtures/run-ts.cjs); on an idle
 * machine one takes 10-20 s, under load much more, hence the 180 s timeouts.
 * Every test has its own state dir (`CODEGRAPH_STATE_DIR`), so no test touches
 * the live server of this machine. A server holds no project until a call
 * names one, so each server below is first given a call that opens the project
 * (the server's builder takes the project's writer slot then).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { getCodeGraphDir } from '../../../src/directory';
import { getServerPidPath } from '../../../src/mcp/daemon-paths';
import { getWriterPidPath } from '../../../src/mcp/writer-lock';
import {
  STALE_GUARD_AGE_S,
  isAlive,
  killAndWait,
  killStarted,
  plantGuard,
  reusePid,
  sleep,
  startUnrelatedHolder,
  startVictim,
  waitFor,
} from './fixtures/dead-lock-helpers';

const REPO = path.resolve(__dirname, '../../..');
const BIN = path.join(REPO, 'dist/bin/codegraph.js');
const posix = process.platform !== 'win32';
const TEST_TIMEOUT_MS = 180_000;

/** Same pid as spawned: no wasm --liftoff-only re-exec; no watchdog or handshake timers. */
const BASE_ENV = {
  CODEGRAPH_MCP_DEBUG: '1',
  CODEGRAPH_MCP_LOG_ATTACH: '1',
  CODEGRAPH_NO_WATCHDOG: '1',
  CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0',
  CODEGRAPH_NO_RELAUNCH: '1',
  CODEGRAPH_WASM_RELAUNCHED: '1',
  CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
  DO_NOT_TRACK: '1',
  CODEGRAPH_TELEMETRY: '0',
};
const DIRECT_ENV = { ...BASE_ENV, CODEGRAPH_NO_DAEMON: '1' };
// A proxy that found no server (a lock younger than the candidate's startup grace
// is deferred to) retries on a short backoff, so it attaches soon after one binds.
const DAEMON_ENV = {
  ...BASE_ENV,
  CODEGRAPH_NO_DAEMON: '0',
  CODEGRAPH_DAEMON_RETRY_MS: '300',
  CODEGRAPH_DAEMON_RETRY_MAX_MS: '1000',
};

interface Server {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stderr: () => string;
  nextId: number;
}

const servers: Server[] = [];

/** The throwaway state dir of the current test; every server below gets it. */
let stateDir: string;

function spawnServer(cwd: string, env: NodeJS.ProcessEnv): Server {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env, CODEGRAPH_STATE_DIR: stateDir },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const lines: string[] = [];
  let buf = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
  const s: Server = { child, lines, stderr: () => err, nextId: 1 };
  servers.push(s);
  return s;
}

function send(s: Server, msg: object): void {
  s.child.stdin.write(JSON.stringify(msg) + '\n');
}

function response(s: Server, id: number): any | null {
  for (const l of s.lines) {
    try {
      const p = JSON.parse(l);
      if (p && p.id === id && (p.result !== undefined || p.error !== undefined)) return p;
    } catch { /* not JSON */ }
  }
  return null;
}

function exited(s: Server): boolean {
  return s.child.exitCode !== null || s.child.signalCode !== null;
}

/** Resolve once the child's output streams have closed, so its stderr is complete. */
function closed(s: Server): Promise<void> {
  return new Promise((r) => {
    if (s.child.stdout.readableEnded && s.child.stderr.readableEnded) return r();
    s.child.once('close', () => r());
    setTimeout(r, 2000);
  });
}

async function request(s: Server, method: string, params: object, timeoutMs: number): Promise<any> {
  const id = s.nextId++;
  send(s, { jsonrpc: '2.0', id, method, params });
  const r = await waitFor(() => response(s, id) ?? (exited(s) ? 'exited' : null), timeoutMs, `${method} from ${s.child.pid}`);
  if (r === 'exited') {
    await closed(s);
    throw new Error(`server ${s.child.pid} exited (${s.child.exitCode ?? s.child.signalCode}) before answering ${method}: ${s.stderr()}`);
  }
  return r;
}

function serverLogTail(): string {
  try {
    return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8').split('\n').slice(-15).join('\n');
  } catch { return '(no server.log)'; }
}

async function initialize(s: Server): Promise<any> {
  const r = await request(s, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dead-lock-reclaim', version: '0.0.0' },
  }, 60_000);
  send(s, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return r;
}

/** `codegraph_search` for the project, which every call must name. */
function search(s: Server, root: string, query: string): Promise<any> {
  return request(s, 'tools/call', { name: 'codegraph_search', arguments: { query, projectPath: root } }, 60_000);
}

function readJson(file: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The pid in this test's `<state>/builder.pid`: the index builder, the process that holds every writer lock of its server. */
function readBuilderPid(): number | null {
  const pid = readJson(path.join(stateDir, 'builder.pid'))?.pid;
  return typeof pid === 'number' ? pid : null;
}

function listeningLines(): number {
  try {
    return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8')
      .split('\n').filter((l) => l.includes('[CodeGraph daemon] Listening on')).length;
  } catch { return 0; }
}

/** The dist the servers run must not be older than the lock code it is meant to contain. */
function assertDistFresh(): void {
  const pairs = [
    ['src/mcp/writer-lock.ts', 'dist/mcp/writer-lock.js'],
    ['src/mcp/lock-takeover.ts', 'dist/mcp/lock-takeover.js'],
    ['src/utils.ts', 'dist/utils.js'],
  ];
  for (const [src, out] of pairs) {
    const s = fs.statSync(path.join(REPO, src!)).mtimeMs;
    const d = fs.statSync(path.join(REPO, out!)).mtimeMs;
    expect(d, `${out} is older than ${src}: run npm run build`).toBeGreaterThanOrEqual(s);
  }
}

let tempDir: string;
let root: string;

const priorStateDir = process.env.CODEGRAPH_STATE_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dlr-gate-'));
  root = fs.realpathSync(tempDir);
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dlr-state-')));
  // getServerPidPath() below reads the state dir from this process's env.
  process.env.CODEGRAPH_STATE_DIR = stateDir;
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function alpha() { return 1; }\n');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
});

afterEach(async () => {
  for (const s of servers.splice(0)) { if (!exited(s)) { try { s.child.kill('SIGKILL'); } catch { /* gone */ } } }
  const server = readJson(getServerPidPath())?.pid;
  if (typeof server === 'number' && server !== process.pid && isAlive(server)) {
    try { process.kill(server, 'SIGKILL'); } catch { /* gone */ }
  }
  const builder = readBuilderPid();
  if (builder !== null && builder !== process.pid && isAlive(builder)) {
    try { process.kill(builder, 'SIGKILL'); } catch { /* gone */ }
  }
  killStarted();
  await sleep(50);
  await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.promises.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (priorStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = priorStateDir;
}, 30_000);

/**
 * Bound on getting the first server killed mid-write: rounds of edits, each
 * followed by up to {@link LOCK_ROUND_MS} of polling for codegraph.lock.
 * Generous because the watcher debounces (2 s by default) before each sync
 * and the machine may be loaded; well inside TEST_TIMEOUT_MS.
 */
const MID_WRITE_BOUND_MS = 60_000;
const LOCK_ROUND_MS = 5_000;

/**
 * Start a direct-mode server, open the project with a call (its index builder
 * takes the project's writer slot), let the builder finish its catch-up, then
 * edit files so its watcher syncs, and SIGKILL the builder (then the server, so
 * none restarts it) the moment codegraph.lock (taken for the sync's writes) is
 * seen. A sync can take and drop the lock between two polls, so each round that
 * does not see it edits again, up to MID_WRITE_BOUND_MS; a lock never seen
 * fails the test, since the kill would then not be proven mid-write. Then a
 * victim takes rebuild.pid and codegraph.lock through the real code and is
 * SIGKILL'd holding them, and a further edit is made while nothing runs, so the
 * next server's catch-up must index it. Returns the pids that named the
 * leftover records: `writerPid` is the killed builder's.
 */
async function killDirectServerMidWrite(): Promise<{ writerPid: number; victimPid: number; lastStart: number }> {
  const first = spawnServer(root, DIRECT_ENV);
  await initialize(first);
  await search(first, root, 'alpha'); // opens the project: the builder takes the writer slot from here
  const serverPid = first.child.pid!;
  const writerPid = await waitFor(() => {
    const w = readJson(getWriterPidPath(root));
    const b = readBuilderPid();
    return b !== null && b !== serverPid && w?.pid === b && w?.ready === true ? b : null;
  }, 60_000, 'the first builder to hold the project and be ready');

  const lockFile = path.join(getCodeGraphDir(root), 'codegraph.lock');
  const giveUp = Date.now() + MID_WRITE_BOUND_MS;
  let sawLock = false;
  for (let round = 0; !sawLock && Date.now() < giveUp; round++) {
    // New files each round: every round is a change the watcher must sync.
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(root, 'src', `bulk${round}_${i}.ts`), `export function bulk${round}_${i}() { return ${i}; }\n`);
    }
    const roundEnd = Math.min(Date.now() + LOCK_ROUND_MS, giveUp);
    while (!(sawLock = fs.existsSync(lockFile)) && Date.now() < roundEnd) await sleep(5);
  }
  expect(sawLock, `codegraph.lock never appeared within ${MID_WRITE_BOUND_MS} ms of edits: the kill would not be mid-write`).toBe(true);
  // The builder dies mid-write; the server goes right after it, before it could start another builder.
  try { process.kill(writerPid, 'SIGKILL'); } catch { /* already gone */ }
  first.child.kill('SIGKILL');
  await waitFor(() => exited(first), 10_000, 'the first server to die');
  await waitFor(() => !isAlive(writerPid), 10_000, 'the first builder to die');
  expect(readJson(getWriterPidPath(root))?.pid, 'the killed builder left its writer.pid').toBe(writerPid);

  const victimPid = await startVictim(root, ['rebuild', 'filelock']);
  await killAndWait(victimPid);
  const lastStart = Date.now();

  fs.writeFileSync(path.join(root, 'src/late.ts'), 'export function reclaimedAfterKill() { return 2; }\n');
  return { writerPid, victimPid, lastStart };
}

/**
 * The acceptance check on a second direct server: it serves, its builder (a new
 * process, not `killedBuilder`) owns writer.pid, and indexed the late edit.
 */
async function expectSecondDirectServerAnswers(killedBuilder: number): Promise<Server> {
  const second = spawnServer(root, DIRECT_ENV);
  await initialize(second);
  // The first call opens the project; the builder claims the slot (and reclaims the leftover records) there.
  const opened = await search(second, root, 'alpha');
  expect(opened.result?.isError, JSON.stringify(opened.result?.content ?? opened.error)).not.toBe(true);
  const builder = await waitFor(() => {
    if (exited(second)) throw new Error(`second server exited (${second.child.exitCode}): ${second.stderr()}`);
    const w = readJson(getWriterPidPath(root));
    const b = readBuilderPid();
    return b !== null && b !== killedBuilder && b !== second.child.pid && w?.pid === b && w?.ready === true ? b : null;
  }, 60_000, 'the second server\'s builder to own writer.pid and finish its catch-up');

  const found = await search(second, root, 'reclaimedAfterKill');
  const text = JSON.stringify(found.result?.content ?? found.error);
  expect(found.result?.isError, text).not.toBe(true);
  expect(text).toContain('reclaimedAfterKill');

  await sleep(500);
  expect(exited(second), second.stderr()).toBe(false);
  expect(readJson(getWriterPidPath(root))?.pid).toBe(builder);
  return second;
}

describe.runIf(posix)('dead-lock reclaim gates', () => {
  it('G-L1 direct mode: server killed mid-write, its pid reused by a live process; the next query answers', async () => {
    assertDistFresh();
    const { writerPid, victimPid, lastStart } = await killDirectServerMidWrite();
    const holder = await startUnrelatedHolder(lastStart);

    const cg = getCodeGraphDir(root);
    reusePid(getWriterPidPath(root), writerPid, holder);
    reusePid(getWriterPidPath(root, 'rebuild.pid'), victimPid, holder);
    reusePid(path.join(cg, 'codegraph.lock'), victimPid, holder);
    plantGuard(getWriterPidPath(root), holder, STALE_GUARD_AGE_S);

    await expectSecondDirectServerAnswers(writerPid);
    expect(isAlive(holder), 'the unrelated holder was signalled').toBe(true);
  }, TEST_TIMEOUT_MS);

  // Regression guard of the acceptance line, not a fix gate: a dead holder's
  // locks are reclaimed on this tree already, and must stay so.
  it('G-L2 direct mode: server killed mid-write, pid left dead; the next query answers', async () => {
    const { writerPid } = await killDirectServerMidWrite();
    plantGuard(getWriterPidPath(root), writerPid, STALE_GUARD_AGE_S);
    await expectSecondDirectServerAnswers(writerPid);
  }, TEST_TIMEOUT_MS);

  it('G-L3 machine-server mode: server killed, server.pid and writer.pid name a live unrelated process; a replacement server binds and serves', async () => {
    assertDistFresh();
    const first = spawnServer(root, DAEMON_ENV);
    await initialize(first);
    await waitFor(() => listeningLines() >= 1, 60_000, 'the first server to listen');
    await search(first, root, 'alpha'); // opens the project: the server's builder takes its writer slot
    const { killed, killedBuilder } = await waitFor(() => {
      const d = readJson(getServerPidPath())?.pid;
      const b = readBuilderPid();
      const w = readJson(getWriterPidPath(root));
      return typeof d === 'number' && b !== null && b !== d && w?.pid === b ? { killed: d, killedBuilder: b } : null;
    }, 60_000, 'the server\'s builder to own writer.pid');
    const serverStarted = Date.now(); // the server and its builder started before this point

    // The proxy first, so it cannot start a replacement before the records are rewritten.
    first.child.kill('SIGKILL');
    await waitFor(() => exited(first), 10_000, 'the first proxy to die');
    // The builder first, with no chance to clean up (it would free its locks on a clean exit when its
    // server goes), then the server before it could start another builder.
    try { process.kill(killedBuilder, 'SIGKILL'); } catch { /* already gone */ }
    await killAndWait(killed);
    await waitFor(() => !isAlive(killedBuilder), 10_000, `builder ${killedBuilder} to exit`);

    const holder = await startUnrelatedHolder(serverStarted);
    reusePid(getServerPidPath(), killed, holder);
    reusePid(getWriterPidPath(root), killedBuilder, holder);

    const second = spawnServer(root, DAEMON_ENV);
    const init = await initialize(second);
    expect(init.result?.serverInfo?.name).toBe('codegraph');
    await waitFor(() => listeningLines() >= 2, 60_000, () =>
      `a replacement server to listen; proxy stderr:\n${second.stderr()}\nserver.log tail:\n${serverLogTail()}`);
    const replacement = await waitFor(() => {
      const d = readJson(getServerPidPath())?.pid;
      return typeof d === 'number' && d !== holder && d !== killed && isAlive(d) ? d : null;
    }, 30_000, 'server.pid to name the replacement');

    // The call must reach the replacement server, not the proxy's in-process
    // fallback (which serves reads without claiming the slot): wait for the attach.
    await waitFor(
      () => second.stderr().includes('Attached to shared daemon') && second.stderr().includes(`(pid ${replacement},`),
      60_000, () => `the proxy to attach to the replacement server ${replacement}; proxy stderr:\n${second.stderr()}`);
    // The first call on the project has the replacement's builder reclaim the leftover writer.pid: not a
    // read-only fallback, the replacement server's builder owns the writer slot.
    const found = await search(second, root, 'alpha');
    const text = JSON.stringify(found.result?.content ?? found.error);
    expect(found.result?.isError, text).not.toBe(true);
    expect(text).toContain('alpha');
    await waitFor(() => {
      const b = readJson(path.join(stateDir, 'builder.pid'));
      return b !== null && b.serverPid === replacement && b.pid !== killedBuilder && readJson(getWriterPidPath(root))?.pid === b.pid;
    }, 30_000,
      `writer.pid to name the replacement server ${replacement}'s builder (builder.pid is ${JSON.stringify(readJson(path.join(stateDir, 'builder.pid')))}, writer.pid names ${JSON.stringify(readJson(getWriterPidPath(root)))})`);
    expect(isAlive(holder), 'the unrelated holder was signalled').toBe(true);
  }, TEST_TIMEOUT_MS);
});
