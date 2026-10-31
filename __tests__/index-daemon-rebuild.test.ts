/**
 * `codegraph index` against a running machine server (#1325).
 *
 * The server keeps SQLite handles open on every project it has answered for. A
 * rebuild recreates the database, so `index` asks the server to release the
 * project (`codegraph/releaseProject`, src/mcp/server-control.ts
 * requestProjectRelease) and never stops it: the server stays up, keeps serving
 * its other clients, and reopens the rebuilt database on the next call. Runs the
 * BUILT binary (dist/bin/codegraph.js) with its own CODEGRAPH_STATE_DIR, so the
 * live server of `~/.codegraph` is never touched.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { isProcessAlive, requestProjectRelease, stopServer } from '../src/mcp/server-control';
import { readWriterLock, releaseWriterLock, tryAcquireWriterLock } from '../src/mcp/writer-lock';
import { recordedPids, recordSpawns, removeSpawnLog } from './daemon-candidates';
import { startFakeServer } from './fake-release-server';

const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
let root: string;
let stateDir: string;
let savedStateDir: string | undefined;
let children: ChildProcessWithoutNullStreams[];

/** The env of every process started here: its own state dir, so its own server. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
    CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_STATE_DIR: stateDir };
  delete env.CODEGRAPH_NO_DAEMON;
  return env;
}

async function until<T>(fn: () => T, timeout = 20000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value as NonNullable<T>;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for process/response');
}
function start(args: string[]) {
  // Record the servers a launcher spawns, for the teardown.
  const recorder = recordSpawns(root);
  const child = spawn(process.execPath, ['--liftoff-only', ...recorder.args, bin, ...args],
    { cwd: root, env: { ...childEnv(), ...recorder.env } });
  children.push(child);
  let out = '', err = '';
  child.stdout.on('data', b => out += b);
  child.stderr.on('data', b => err += b);
  child.stdin.on('error', () => {});
  return { child, output: () => out, errors: () => err };
}
type Server = ReturnType<typeof start>;
function send(server: Server, id: number, method: string, params: unknown = {}) {
  server.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}
async function response(server: Server, id: number) {
  return until(() => server.output().split('\n').map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).find(m => m?.id === id));
}
/** One explore call through a session, `projectPath` named as every call must. */
async function explore(server: Server, id: number, query: string) {
  send(server, id, 'tools/call',
    { name: 'codegraph_explore', arguments: { query, projectPath: root } });
  return response(server, id);
}
/** The pid in the state dir's `server.pid`, once the first launcher has started the server. */
async function serverPid(): Promise<number> {
  return until(() => {
    try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8')).pid as number; } catch { return 0; }
  });
}
async function client() {
  const server = start(['serve', '--mcp', '--path', root]);
  send(server, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'rebuild-test', version: '1' } });
  await response(server, 1);
  expect((await explore(server, 2, 'originalSymbol')).result.isError).not.toBe(true);
  return server;
}
async function rebuild() {
  const cmd = start(['index', '--quiet']);
  await until(() => cmd.child.exitCode !== null || cmd.child.signalCode !== null, 60000);
  expect(cmd.errors()).not.toContain('Failed to index');
  expect(cmd.child.exitCode).toBe(0);
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-')));
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-state-')));
  // This process finds the server (stopServer, requestProjectRelease) by the same state dir.
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = stateDir;
  children = [];
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function originalSymbol() {}\n');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
});
afterEach(async () => {
  releaseWriterLock(root, 'rebuild.pid');
  // Close each launcher's stdin and let it exit; never kill one. A launcher
  // serving calls in-process retries its server on a timer, and a retry that
  // comes due during a call spawns the server as soon as that call answers,
  // just as this teardown begins. On Windows a launcher killed mid-spawn leaves
  // that server suspended for good: it never runs, so no server.pid names it
  // and nothing can stop it.
  for (const child of children) child.stdin.end();
  await until(() => children.every(c => c.exitCode !== null || c.signalCode !== null), 30000);
  // Then stop the server the launchers recorded. One spawned as its launcher
  // exited may still be starting, and stopServer leaves a server running
  // until it answers its socket, so keep at it until all have exited.
  const end = Date.now() + 30000;
  while (recordedPids(root).some(isProcessAlive)) {
    if (Date.now() > end) throw new Error(`Servers ${recordedPids(root).filter(isProcessAlive).join(', ')} are still running`);
    await stopServer();
    await new Promise(r => setTimeout(r, 25));
  }
  removeSpawnLog(root);
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 90000);

it('rebuilds with SQLite held by the server, leaves the server running and serves the new graph (#1325)', async () => {
  const server = await client();
  const pid = await serverPid();
  expect(isProcessAlive(pid)).toBe(true);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function replacementSymbol() {}\n');
  await rebuild();
  // The rebuild released the project; it never stopped the server or its client's session.
  expect(isProcessAlive(pid)).toBe(true);
  expect(server.child.exitCode).toBeNull();
  const reply = await explore(server, 3, 'replacementSymbol');
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(JSON.stringify(reply.result)).toContain('replacementSymbol');
  expect(await serverPid()).toBe(pid);
}, 90000);

it('keeps an active client from reopening SQLite during rebuild and serves the new graph afterward', async () => {
  const server = await client();
  const pid = await serverPid();
  // Hold the exact CLI rebuild fence to deterministically exercise a request
  // arriving between the project's release and the database's recreation.
  expect(tryAcquireWriterLock(root, 'rebuild', 'rebuild.pid').kind).toBe('acquired');
  expect(await requestProjectRelease(root)).toBe('released');
  const during = await explore(server, 3, 'originalSymbol');
  // Guidance, never a tool error: a rebuild is expected and brief.
  expect(during.result.isError).not.toBe(true);
  expect(JSON.stringify(during.result)).toContain('rebuild is in progress');
  expect(readWriterLock(root)?.mode).not.toBe('fallback');
  releaseWriterLock(root, 'rebuild.pid');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export function replacementSymbol() {}\n');
  await rebuild();
  const reply = await explore(server, 4, 'replacementSymbol');
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).not.toBe(true);
  expect(JSON.stringify(reply.result)).toContain('replacementSymbol');
  expect(isProcessAlive(pid)).toBe(true);
}, 90000);

it('preserves a foreign writer and the existing database', async () => {
  expect(tryAcquireWriterLock(root, 'direct').kind).toBe('acquired');
  const before = fs.readFileSync(path.join(root, '.codegraph/codegraph.db'));
  try {
    const cmd = start(['index', '--quiet']);
    await until(() => cmd.child.exitCode !== null);
    expect(cmd.child.exitCode).toBe(1);
    expect(cmd.errors()).toContain('writer lock held');
    expect(readWriterLock(root)?.pid).toBe(process.pid);
    expect(fs.readFileSync(path.join(root, '.codegraph/codegraph.db'))).toEqual(before);
  } finally { releaseWriterLock(root); }
});

it('does not rebuild when the server does not confirm the release, and the database is untouched', async () => {
  const before = fs.readFileSync(path.join(root, '.codegraph/codegraph.db'));
  const fake = await startFakeServer({ reply: () => ({ error: { code: -32603, message: 'could not release' } }) });
  try {
    const cmd = start(['index', '--quiet']);
    await until(() => cmd.child.exitCode !== null, 60000);
    expect(cmd.child.exitCode).toBe(1);
    expect(cmd.errors()).toContain('did not confirm that it released');
    expect(fs.readFileSync(path.join(root, '.codegraph/codegraph.db'))).toEqual(before);
  } finally { await fake.close(); }
});
