/**
 * An engine with no index builder (`new MCPEngine()`, the proxy's in-process
 * fallback while the machine server is unreachable) never writes an index, on ANY
 * path a call can take: not through the tool it names, not through the `fresh`
 * argument, not through the status tool's change count, not through a worktree
 * seed, and not through a call that skips the repo guard.
 *
 * Worktree seeding writes: it copies an index into the worktree, stamps a nonce
 * into it, registers the worktree in the project registry and takes the
 * target's `codegraph.lock` while it copies. `fresh: true` syncs, and a sync takes
 * `codegraph.lock` and writes the database. A writable open of an index with an
 * unfinished repair heals it. A read-only engine must do none of that, so the
 * matrix below runs EVERY tool name x { fresh on an indexed worktree, fresh on a
 * seedable unindexed worktree, no projectPath } and the status tool, plus an
 * unknown tool name and a missing one, through the two real front doors (an
 * MCPSession, and the proxy fallback run as a child process on the built modules),
 * and after each call asserts that nothing on disk moved:
 *   - the index database: bytes, and its content as a reader sees it (schema
 *     objects and row counts, which also shows a change still in the `-wal`);
 *   - every file under the indexed worktree's `.codegraph/` and under the
 *     unindexed worktree (sizes, mtimes; `-wal`/`-shm` ignored: a read-only
 *     connection to a WAL database may create and remove them);
 *   - the project registry directory;
 *   - no `codegraph.lock`, `writer.pid` or `rebuild.pid` was created at any
 *     moment of the call (a file watcher on the trees records every name, so a
 *     lock taken and released inside the call is seen too).
 * The control shows the same fixture IS written when the engine has a builder (a
 * real one, in its own process), so the absence of a write is the builderless
 * engine's doing and not a fixture that could never write.
 *
 * A second class is pinned structurally: the handler's `execute` has exactly one
 * caller outside the CLI (the shared dispatch), so no front door can drop a rule.
 *
 * Real git worktrees and real SQLite in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import CodeGraph from '../../../src/index';
import { FileLock } from '../../../src/utils';
import { MCPEngine } from '../../../src/mcp/engine';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { MCPSession } from '../../../src/mcp/session';
import {
  ErrorCodes,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcTransport,
  type MessageHandler,
} from '../../../src/mcp/transport';
import { __setLoadCodeGraphForTests, tools as BUILTIN_TOOLS, type ToolResult } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, extensionTools, registerExtension } from '../../../src/extensions/host/registry';
import hostExtension from '../../../src/extensions/host/extension';
import queriesExtension from '../../../src/extensions/queries/extension';
import resolutionExtension from '../../../src/extensions/resolution/extension';
import { MISSING_PROJECT_PATH_TEXT, resolveRepoAnchor } from '../../../src/extensions/host/server/repo-anchor';
import { READ_ONLY_SYNC_ERROR } from '../../../src/extensions/host/fresh/checkpoint';
import {
  getRegisteredProject,
  listRegisteredProjects,
  registryDir,
  unregisterProject,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { ADMIT_ALL } from '../../helpers/admit-all';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

const NOT_INDEXED = "isn't indexed with codegraph";
const FORBIDDEN_NAMES = ['codegraph.lock', 'writer.pid', 'rebuild.pid'];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every `codegraph.lock` at or below `dir` (a seed's target lock, a build's). */
function locksUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'codegraph.lock') found.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

/** `relative path -> size:mtime` of every file under `dir`, `-wal`/`-shm` left out; `.git` and `node_modules` are skipped. */
function treeState(dir: string, into: Record<string, string>, prefix: string): void {
  if (!fs.existsSync(dir)) {
    into[`${prefix}(absent)`] = 'absent';
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      treeState(full, into, `${prefix}${entry.name}/`);
    } else {
      const st = fs.statSync(full);
      into[`${prefix}${entry.name}`] = `${st.size}:${st.mtimeMs}`;
    }
  }
}

/** Records every file name created, changed or removed under `roots` until stopped. */
function watchNames(roots: string[]): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const watchers = roots
    .filter((r) => fs.existsSync(r))
    .map((r) => fs.watch(r, { recursive: true }, (_event, name) => { if (name) seen.add(path.basename(name.toString())); }));
  return { seen, stop: () => watchers.forEach((w) => w.close()) };
}

/** A transport with no wire: `call` hands a request to the session and resolves with its reply. */
class MemoryTransport implements JsonRpcTransport {
  private handler: MessageHandler | null = null;
  private nextId = 1;
  private waiting = new Map<string | number, (reply: Reply) => void>();
  start(handler: MessageHandler): void { this.handler = handler; }
  stop(): void { /* nothing to close */ }
  send(_response: JsonRpcResponse): void { /* replies arrive through sendResult / sendError */ }
  notify(_method: string, _params?: unknown): void { /* none expected */ }
  request(): Promise<unknown> { return Promise.reject(new Error('the session asked the client something')); }
  sendResult(id: string | number, result: unknown): void { this.waiting.get(id)?.({ result: result as ToolResult }); }
  sendError(id: string | number | null, code: number, message: string): void {
    if (id !== null) this.waiting.get(id)?.({ error: { code, message } });
  }
  call(method: string, params: unknown): Promise<Reply> {
    const id = this.nextId++;
    const reply = new Promise<Reply>((resolve) => this.waiting.set(id, resolve));
    const request: JsonRpcRequest | JsonRpcNotification = { jsonrpc: '2.0', id, method, params };
    void this.handler!(request as JsonRpcRequest);
    return reply;
  }
}

interface Reply {
  result?: ToolResult;
  error?: { code: number; message: string };
}

/** The ONE way the matrix asks for a tool: through a front door's wire protocol. */
type CallTool = (name: string | undefined, args: Record<string, unknown>) => Promise<Reply>;

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');

/**
 * The built proxy with the machine server unreachable (fixtures/proxy-fallback.cjs), driven over
 * stdio: `rpc` sends one JSON-RPC request and resolves with its reply. `launchDir` undefined starts a
 * session that reported no launch directory.
 */
function startFallbackProxy(launchDir: string | undefined): {
  child: ChildProcess;
  rpc: (method: string, params: unknown) => Promise<Reply>;
  stderr: () => string;
} {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1',
    CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_PPID_POLL_MS: '0',
    CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '0', CODEGRAPH_DAEMON_RETRY_MS: '0',
  };
  if (launchDir === undefined) delete env.CG_LAUNCH_DIR;
  else env.CG_LAUNCH_DIR = launchDir;
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'proxy-fallback.cjs')], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: ToolResult; error?: Reply['error'] };
        if (msg.id !== undefined) waiting.get(msg.id)?.({ result: msg.result, error: msg.error });
      } catch { /* not a reply */ }
    }
  });
  child.stderr!.on('data', (d) => { stderr += d; });
  child.stdin!.on('error', () => { /* the child is gone; the awaited reply says so */ });
  const gone = new Promise<never>((_resolve, reject) => {
    child.once('exit', () => reject(new Error(`the proxy exited: ${stderr}`)));
  });
  gone.catch(() => { /* surfaced through the awaited reply */ });
  let nextId = 1;
  const rpc = (method: string, params: unknown): Promise<Reply> => {
    const id = nextId++;
    const reply = Promise.race([new Promise<Reply>((resolve) => waiting.set(id, resolve)), gone]);
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  };
  return { child, rpc, stderr: () => stderr };
}

describe('a read-only engine never writes an index', { timeout: 120_000 }, () => {
  let workspace: string;
  let main: string;
  let w2: string;
  let engine: MCPEngine | undefined;
  let proxy: ChildProcess | undefined;
  // In-process observers of the two ways an index gets written: a sync, and the
  // file lock it (and a seed) takes. The file watcher below sees them across
  // the process boundary; these see a lock taken and released inside one
  // synchronous stretch, which a watcher can miss.
  let syncSpy: MockInstance;
  let lockSpy: MockInstance;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ['CODEGRAPH_NO_AUTO_SEED', 'CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS']) saved[k] = process.env[k];
    delete process.env.CODEGRAPH_NO_AUTO_SEED;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-readonly-')));
    main = path.join(workspace, 'main');
    w2 = path.join(workspace, 'w2');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@example.com');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(main, 'src', 'alpha.ts'), 'export function alphaSymbol() { return "alpha-body-marker"; }\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    // The indexed worktree, and the sibling worktree whose index can be seeded.
    const cg = await CodeGraph.init(main);
    await cg.indexAll();
    cg.close();
    git(main, 'worktree', 'add', '-q', '-b', 'w2', w2);
    // Two reasons a writer would act on `main` when asked: files the index has
    // not caught up with (`fresh: true` would sync them), and a bulk-load repair
    // the last writer never finished (a FTS trigger is missing), which every
    // WRITABLE open heals by rewriting the database.
    fs.appendFileSync(path.join(main, 'src', 'alpha.ts'), 'export function addedLater() { return 2; }\n');
    fs.writeFileSync(path.join(main, 'src', 'beta.ts'), 'export function betaSymbol() { return 3; }\n');
    const db = new DatabaseSync(path.join(main, '.codegraph', 'codegraph.db'));
    db.exec('DROP TRIGGER IF EXISTS nodes_au');
    db.close();
    fs.mkdirSync(registryDir(), { recursive: true });
    __setLoadCodeGraphForTests(CodeGraph);
    syncSpy = vi.spyOn(CodeGraph.prototype, 'sync');
    lockSpy = vi.spyOn(FileLock.prototype, 'acquire');
    // Under vitest the extensions are sources, which the registry does not
    // discover (the built proxy child discovers its compiled siblings), so the
    // tool surface is registered here: every extension the product ships.
    __resetExtensionsForTests();
    for (const ext of [hostExtension, queriesExtension, resolutionExtension]) registerExtension(ext);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    proxy?.kill('SIGKILL');
    proxy = undefined;
    await engine?.stop();
    engine = undefined;
    __setLoadCodeGraphForTests(null);
    __resetExtensionsForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of listRegisteredProjects()) unregisterProject(p.root);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  /**
   * The index as a reader sees it: its schema objects and its row counts. A
   * writer's changes sit in the `-wal` file until a checkpoint, so the main
   * file's bytes alone would not show a write that a still-open connection keeps
   * from checkpointing: this does.
   */
  function logicalDigest(): string {
    const db = new DatabaseSync(path.join(main, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const schema = db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all();
      const counts = ['files', 'nodes', 'edges', 'unresolved_refs'].map((t) => {
        const row = db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number };
        return `${t}=${row.c}`;
      });
      return JSON.stringify({ schema, counts });
    } finally {
      db.close();
    }
  }

  /** Everything a call could move: the index, the unindexed worktree, the registry. */
  function diskState(): { files: Record<string, string>; dbHash: string; logical: string; locks: string[] } {
    const files: Record<string, string> = {};
    treeState(path.join(main, '.codegraph'), files, 'main/.codegraph/');
    treeState(w2, files, 'w2/');
    treeState(registryDir(), files, 'registry/');
    const dbHash = createHash('sha256').update(fs.readFileSync(path.join(main, '.codegraph', 'codegraph.db'))).digest('hex');
    return { files, dbHash, logical: logicalDigest(), locks: [...locksUnder(main), ...locksUnder(w2)] };
  }

  /**
   * Make one call through `call` and assert the disk state did not move at any
   * moment of it. Soft assertions: one run lists EVERY call that moved something,
   * not only the first.
   */
  async function callAndExpectUntouched(label: string, call: CallTool, name: string | undefined, args: Record<string, unknown>): Promise<Reply> {
    const before = diskState();
    syncSpy.mockClear();
    lockSpy.mockClear();
    const watch = watchNames([main, w2, registryDir()]);
    let reply: Reply;
    try {
      reply = await call(name, args);
      await delay(80); // file events arrive after the operation that caused them
    } finally {
      watch.stop();
    }
    expect.soft(syncSpy, `${label}: an index was synced`).not.toHaveBeenCalled();
    expect.soft(lockSpy, `${label}: a file lock was taken`).not.toHaveBeenCalled();
    const after = diskState();
    expect.soft(after.files, `${label}: files changed`).toEqual(before.files);
    expect.soft(after.dbHash, `${label}: the index database was written`).toBe(before.dbHash);
    expect.soft(after.logical, `${label}: the index was repaired or changed through its write-ahead log`).toBe(before.logical);
    expect.soft(after.locks, `${label}: a lock file is left behind`).toEqual([]);
    for (const forbidden of FORBIDDEN_NAMES) {
      expect.soft(watch.seen.has(forbidden), `${label}: ${forbidden} was created during the call`).toBe(false);
    }
    expect.soft(fs.existsSync(path.join(w2, '.codegraph')), `${label}: a .codegraph/ appeared in the unindexed worktree`).toBe(false);
    expect.soft(getRegisteredProject(w2), `${label}: the worktree was registered`).toBeNull();
    return reply;
  }

  const ARGS = { query: 'alphaSymbol', symbol: 'alphaSymbol', pattern: 'alphaSymbol', task: 'alphaSymbol' };

  /** The whole matrix, through one front door. */
  async function runMatrix(door: string, call: CallTool): Promise<void> {
    const names = [...BUILTIN_TOOLS.map((t) => t.name), ...extensionTools().map((t) => t.definition.name)];
    expect(names, 'the matrix covers the extension tools too').toContain('codegraph_grep');
    expect(names).toContain('codegraph_status');

    for (const name of names) {
      const label = `${door} ${name}`;
      await callAndExpectUntouched(`${label} fresh on the indexed worktree`, call, name, { ...ARGS, projectPath: main, fresh: true });
      await callAndExpectUntouched(`${label} fresh on the seedable worktree`, call, name, { ...ARGS, projectPath: w2, fresh: true });
      const bare = await callAndExpectUntouched(`${label} without projectPath`, call, name, { ...ARGS, fresh: true });
      expect(bare.error, `${label} without projectPath`).toBeUndefined();
      expect(bare.result?.isError, `${label} without projectPath`).toBeFalsy();
      expect(textOf(bare.result!), `${label} without projectPath`).toBe(MISSING_PROJECT_PATH_TEXT);
    }

    // Status measures the pending changes on a worker thread that opens the index read-only.
    for (const projectPath of [main, w2]) {
      for (const fresh of [false, true]) {
        const status = await callAndExpectUntouched(`${door} codegraph_status ${projectPath === main ? 'indexed' : 'seedable'} fresh=${fresh}`,
          call, 'codegraph_status', { projectPath, ...(fresh ? { fresh } : {}) });
        expect(status.error).toBeUndefined();
        expect(status.result?.isError, status.result ? textOf(status.result) : '').toBeFalsy();
      }
    }

    // A name that is no tool, with a projectPath that would be opened and synced
    // if the call got as far as the handler.
    const unknown = await callAndExpectUntouched(`${door} unknown tool`, call, 'codegraph_no_such_tool', { projectPath: main, fresh: true });
    expect(unknown.result, `${door} unknown tool is not answered as a tool result`).toBeUndefined();
    expect(unknown.error?.code).toBe(ErrorCodes.InvalidParams);
    expect(unknown.error?.message).toContain('Unknown tool: codegraph_no_such_tool');
    for (const blank of [undefined, '', '   ']) {
      const missing = await callAndExpectUntouched(`${door} missing tool name ${JSON.stringify(blank)}`, call, blank, { projectPath: main, fresh: true });
      expect(missing.result).toBeUndefined();
      expect(missing.error?.code).toBe(ErrorCodes.InvalidParams);
    }

    // The answer a read-only engine gives for `fresh: true` over pending files
    // is the not-fresh notice, naming why no sync ran, and it is still an answer.
    const fresh = await callAndExpectUntouched(`${door} explore fresh note`, call, 'codegraph_explore', { query: 'alphaSymbol', projectPath: main, fresh: true });
    expect(fresh.result?.isError).toBeFalsy();
    expect(textOf(fresh.result!)).toContain('alpha-body-marker');
    expect(textOf(fresh.result!)).toContain('fresh=no');
    expect(textOf(fresh.result!)).toContain(`the index could not be synced (${READ_ONLY_SYNC_ERROR})`);

    // The unindexed worktree gets the plain not-indexed guidance.
    const unindexed = await callAndExpectUntouched(`${door} explore unindexed`, call, 'codegraph_explore', { query: 'alphaSymbol', projectPath: w2 });
    expect(unindexed.result?.isError).toBeFalsy();
    expect(textOf(unindexed.result!)).toContain(NOT_INDEXED);
  }

  // Over 5 s by design: the matrix is ~50 calls, each followed by an 80 ms wait for the
  // file watcher's events (a lock taken and released inside a call is only seen there).
  it('matrix: every tool, fresh, status, unknown and missing names, through an MCPSession', async () => {
    engine = new MCPEngine();
    const transport = new MemoryTransport();
    new MCPSession(transport, engine, { anchor: await resolveRepoAnchor(main) }).start();
    await runMatrix('session', (name, args) =>
      transport.call('tools/call', { ...(name === undefined ? {} : { name }), arguments: args }));
  });

  // Over 5 s by design: the same ~50 calls and watcher waits as the session matrix, plus the
  // child process start.
  it('matrix: the same, through the proxy fallback (the built proxy over stdio)', async () => {
    const fallback = startFallbackProxy(main);
    proxy = fallback.child;
    await fallback.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '1' } });
    await runMatrix('proxy fallback', (name, args) =>
      fallback.rpc('tools/call', { ...(name === undefined ? {} : { name }), arguments: args }));
    expect(fallback.stderr(), 'the calls were served in-process').toContain('serving this session in-process');
  });

  it('the proxy fallback does not latch a failed anchor: each call asks again, the failure is logged once, and the answer is guidance', async () => {
    // No launch directory at all makes the anchor's resolution reject on every attempt.
    const fallback = startFallbackProxy(undefined);
    proxy = fallback.child;
    await fallback.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '1' } });
    for (let i = 0; i < 3; i++) {
      const reply = await fallback.rpc('tools/call', { name: 'codegraph_explore', arguments: { query: 'alphaSymbol', projectPath: main } });
      expect(reply.error, `call ${i}`).toBeUndefined();
      expect(reply.result?.isError, `call ${i}`).toBeFalsy();
      expect(textOf(reply.result!), `call ${i}`).toContain('did not report the directory it was launched in');
    }
    expect(fallback.stderr().split('Could not resolve the repository of').length - 1, 'logged once, not per call').toBe(1);
  });

  it('a handler that owns a lifecycle refuses a call that skipped the admission check, and a name that is no tool, before opening anything', async () => {
    engine = new MCPEngine();
    const handler = engine.getToolHandler();

    const unadmitted = await callAndExpectUntouched('unadmitted call', (name, args) => handler.execute(name!, args).then((result) => ({ result })),
      'codegraph_explore', { ...ARGS, projectPath: main, fresh: true });
    expect(unadmitted.result?.isError, `success-shaped, so the agent is not taught to abandon the tools: ${textOf(unadmitted.result!)}`).toBeFalsy();
    expect(textOf(unadmitted.result!)).toContain('was not run');
    expect(textOf(unadmitted.result!)).not.toContain('alpha-body-marker');

    const unknown = await callAndExpectUntouched('unknown tool at the handler', (name, args) => handler.execute(name!, args, undefined, ADMIT_ALL).then((result) => ({ result })),
      'codegraph_no_such_tool', { projectPath: main, fresh: true });
    expect(unknown.result?.isError).toBe(true);
    expect(textOf(unknown.result!)).toContain('Unknown tool: codegraph_no_such_tool');
  });

  it('leaves an unindexed sibling worktree untouched and answers the not-indexed guidance', async () => {
    engine = new MCPEngine();

    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: w2 }, undefined, ADMIT_ALL);

    expect(res.isError, 'the answer is success-shaped').toBeFalsy();
    expect(textOf(res)).toContain(NOT_INDEXED);
    expect(textOf(res)).not.toContain('alpha-body-marker');
    expect(fs.existsSync(path.join(w2, '.codegraph')), 'no .codegraph/ was created in the worktree').toBe(false);
    expect(locksUnder(w2), 'no codegraph.lock was taken in the worktree').toEqual([]);
    expect(getRegisteredProject(w2), 'the worktree was not registered').toBeNull();
    expect(listRegisteredProjects().map((p) => p.root)).not.toContain(w2);
  });

  // Over 5 s by design: a real builder process starts, seeds a worktree, and syncs an index on an overloaded machine.
  it('control: an engine with a builder has the same worktree seeded and the same index synced (the fixture can be written)', async () => {
    const builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
    try {
      const before = diskState();

      const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: w2 }, undefined, ADMIT_ALL);
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('alpha-body-marker');
      expect(fs.existsSync(path.join(w2, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(getRegisteredProject(w2)).not.toBeNull();

      const synced = await engine.getToolHandler().execute('codegraph_explore', { query: 'betaSymbol', projectPath: main, fresh: true }, undefined, ADMIT_ALL);
      expect(synced.isError).toBeFalsy();
      expect(textOf(synced)).toContain('fresh=yes');
      expect(diskState().dbHash, 'the builder wrote the index').not.toBe(before.dbHash);
    } finally {
      await engine.stop();
      await builder.stop();
    }
  });
});

describe('ToolHandler.execute has one caller outside the CLI', () => {
  const root = path.resolve(__dirname, '../../..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  /** Every call `<something>.execute(<args>)` in the file, found on the syntax tree (comments and strings never match). */
  function executeCalls(file: string): number {
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'execute' && node.arguments.length > 0) calls++;
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return calls;
  }

  it('is called only by the shared dispatch (the CLI in src/bin builds its own handler without a lifecycle)', () => {
    const callers = [...sourceFiles(path.join(root, 'src', 'mcp')), ...sourceFiles(path.join(root, 'src', 'extensions', 'host'))]
      .map((file) => ({ file: path.relative(root, file), calls: executeCalls(file) }))
      .filter((f) => f.calls > 0);
    expect(callers).toEqual([{ file: path.join('src', 'extensions', 'host', 'server', 'tool-call.ts'), calls: 1 }]);
  });
});
