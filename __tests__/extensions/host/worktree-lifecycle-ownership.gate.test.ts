/**
 * Ownership and lifetime gates of request worktree-lifecycle (Adams post-flight,
 * level-2 rework). Each case drives the shipped entry point and asserts what is
 * left on disk or which handles are still held, not names or return values.
 *
 * O1 cold build (`runColdBuild`, the detached child's entry): a failed build
 *    deletes only a database this process created. An index another
 *    initializer made between the child's own check and `CodeGraph.init`'s
 *    (init awaits the grammar load before it checks again, so the window is
 *    real) survives with its rows, whether init then throws "already
 *    initialized" or fails before it creates anything.
 * O2 teardown (`sweepWorktrees`): a seeded worktree removed and replaced, before
 *    a sweep, by a directory whose index the user built (another repository at
 *    the same path, or the same directory once it lost its .git). The seed
 *    wrote a nonce into the index it installed and the registry recorded it;
 *    the user's index carries none, so the sweep unregisters the root and
 *    leaves that index, rows and all.
 * O3 engine explicit leases (`MCPEngine.releaseProjectRoot`): a call that
 *    reopens a root while its release waits for in-flight calls takes a
 *    second lease on the same CodeGraph; both leases are released, so the
 *    writer slot is freed once the root is released again.
 * O4 query pool (`QueryPool.releaseProject`): the release does not resolve
 *    while a retiring worker, which may still hold the root, has not exited.
 * O5 engine default project (`MCPEngine.runHousekeepingTick`): a seeded
 *    worktree serving as the engine's default project is removed; one pass
 *    retires the default (its lease, watcher and database handles are let
 *    go) and unregisters the root. Afterwards the default-project search
 *    (`retryInitializeSync`, `ensureInitialized`) adopts only that same root
 *    once it has an index again, never the index of the checkout above it.
 *
 * Real git repositories and real SQLite in mkdtemp dirs; O4 uses fake pool
 * workers, so the retiring worker's exit is in the test's hands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { MCPEngine } from '../../../src/mcp/engine';
import { QueryPool, type PoolWorker } from '../../../src/mcp/query-pool';
import { __setLoadCodeGraphForTests, type ToolHandler, type ToolResult } from '../../../src/mcp/tools';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import {
  getRegisteredProject,
  listRegisteredProjects,
  readSeedNonce,
  unregisterProject,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { ensureWorktreeIndex } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { sweepWorktrees } from '../../../src/extensions/host/worktree-lifecycle/teardown';

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v']).error === undefined;

// The built engine (dist/ is rebuilt by the make-run global setup), for O5's
// default-project open, as __tests__/index-recovery-off-thread.test.ts does.
const DIST = path.resolve(__dirname, '../../../dist');
const { MCPEngine: DistMCPEngine } = require(path.join(DIST, 'mcp', 'engine.js')) as typeof import('../../../src/mcp/engine');
type DistEngine = InstanceType<typeof DistMCPEngine>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

/** A one-commit repository holding `file` with `body`. */
function makeRepo(dir: string, file = 'app.ts', body = 'export function appSymbol() { return 42; }\n'): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

function dbFile(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}

/** The index's files and nodes, ordered: what "the user's rows" means here. */
function indexRows(root: string): { files: string[]; nodes: string[] } {
  const db = new DatabaseSync(dbFile(root), { readOnly: true });
  try {
    const files = (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map((r) => r.path);
    const nodes = (db.prepare('SELECT name FROM nodes ORDER BY name').all() as { name: string }[]).map((r) => r.name);
    return { files, nodes };
  } finally {
    db.close();
  }
}

/** This process's open fds on exactly these files, per `lsof -p <pid> -Fn`. */
function openFdCount(files: string[]): number {
  const out = spawnSync('lsof', ['-p', String(process.pid), '-Fn'], { encoding: 'utf8' }).stdout ?? '';
  const wanted = new Set(files);
  return out.split('\n').filter((l) => l.startsWith('n') && wanted.has(l.slice(1))).length;
}

/** Roots the handler holds open: its private per-project cache, read structurally. */
function cachedRoots(handler: ToolHandler): string[] {
  const cache = (handler as unknown as { projectCache?: unknown }).projectCache;
  return cache instanceof Map ? [...cache.keys()] as string[] : [];
}

function clearRegistry(): void {
  for (const p of listRegisteredProjects()) unregisterProject(p.root);
}

/** A promise a test opens by hand. */
class Gate {
  readonly promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((r) => { this.open = r; }); }
}

// ---------------------------------------------------------------------------
// O1: a failed cold build deletes only what it created
// ---------------------------------------------------------------------------

describe('O1: a failed cold build never deletes an index someone else made', { timeout: 60_000 }, () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-cold-')));
    root = path.join(workspace, 'repo');
    makeRepo(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Hold CodeGraph.init (the child's own call) until another initializer has
   * built a complete index of the root, then let `after` decide what init
   * does: the real init, which now finds the index and throws, or a failure
   * of its own before it creates anything (a grammar load that fails).
   */
  function userIndexesDuringInit(after: 'real-init' | 'fail-before-create'): { rows: () => { files: string[]; nodes: string[] } } {
    const realInit = CodeGraph.init.bind(CodeGraph);
    let built: { files: string[]; nodes: string[] } | null = null;
    vi.spyOn(CodeGraph, 'init').mockImplementation(async (projectRoot, options) => {
      vi.mocked(CodeGraph.init).mockRestore();
      await indexDir(projectRoot);
      built = indexRows(projectRoot);
      if (after === 'fail-before-create') throw new Error('grammar load failed');
      return realInit(projectRoot, options);
    });
    return { rows: () => built! };
  }

  it('init throws "already initialized": the other initializer\'s index and rows survive', async () => {
    const user = userIndexesDuringInit('real-init');
    const code = await runColdBuild(root);
    expect(code).not.toBe(0);
    expect(fs.existsSync(dbFile(root))).toBe(true);
    expect(user.rows().nodes).toContain('appSymbol');
    expect(indexRows(root)).toEqual(user.rows());
    // The child released its fence and registered nothing: the index is not its.
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(getRegisteredProject(root)).toBeNull();
  });

  it('init fails before creating anything while the other index lands: that index survives', async () => {
    const user = userIndexesDuringInit('fail-before-create');
    const code = await runColdBuild(root);
    expect(code).not.toBe(0);
    expect(fs.existsSync(dbFile(root))).toBe(true);
    expect(indexRows(root)).toEqual(user.rows());
    expect(getRegisteredProject(root)).toBeNull();
  });

  it('an index the child created and failed to fill is still removed', async () => {
    vi.spyOn(CodeGraph.prototype, 'indexAll').mockResolvedValue({ success: false } as Awaited<ReturnType<CodeGraph['indexAll']>>);
    const code = await runColdBuild(root);
    expect(code).not.toBe(0);
    expect(fs.existsSync(dbFile(root))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O2: teardown of a replaced seeded worktree
// ---------------------------------------------------------------------------

describe('O2: teardown never deletes an index the user built at a seeded root', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let wt: string;
  /** The user's index rows, read before the sweep. */
  let before: { files: string[]; nodes: string[] };

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-teardown-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
    await indexDir(main);
    wt = path.join(workspace, 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    // The real seed: copied from main, registered SEEDED with main's common
    // dir and the nonce the installed index carries. Without a recorded
    // nonce teardown would spare any index, so the cases below would prove
    // nothing: assert it is there and matches.
    const outcome = await ensureWorktreeIndex(wt);
    expect(outcome.kind).toBe('seeded');
    const rec = getRegisteredProject(wt);
    expect(rec?.seedNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(readSeedNonce(wt)).toBe(rec!.seedNonce);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // The registry records that the ROOT was seeded and the seed nonce the
  // installed index carries; teardown deletes only a database holding that
  // nonce. The user's index below is built by CodeGraph.init + indexAll, as
  // `codegraph init` builds one, so it has no nonce and must survive. Each
  // scenario is arranged in its own beforeEach, so a failure while arranging
  // fails the hook, never the case.
  describe('another repository at the same path, indexed by the user', () => {
    beforeEach(async () => {
      git(main, 'worktree', 'remove', '--force', wt);
      makeRepo(wt, 'own.ts', 'export function ownSymbol() { return 7; }\n');
      await indexDir(wt);
      before = indexRows(wt);
      expect(before.nodes).toContain('ownSymbol');
    });

    it('its index survives the sweep', async () => {
      await sweepWorktrees({ release: async () => { /* nothing open here */ } });
      expect(fs.existsSync(dbFile(wt))).toBe(true);
      expect(indexRows(wt)).toEqual(before);
      // Torn down all the same: only the index is spared.
      expect(getRegisteredProject(wt)).toBeNull();
    });
  });

  describe('the same directory after it lost its .git, re-indexed by the user', () => {
    beforeEach(async () => {
      fs.rmSync(path.join(wt, '.git'), { force: true });
      git(main, 'worktree', 'prune');
      // The user discards the seeded index and builds their own.
      fs.rmSync(path.join(wt, '.codegraph'), { recursive: true, force: true });
      await indexDir(wt);
      before = indexRows(wt);
      expect(before.nodes).toContain('appSymbol');
    });

    it('its index survives the sweep', async () => {
      await sweepWorktrees({ release: async () => { /* nothing open here */ } });
      expect(fs.existsSync(dbFile(wt))).toBe(true);
      expect(indexRows(wt)).toEqual(before);
      // Torn down all the same: only the index is spared.
      expect(getRegisteredProject(wt)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// O3 and O5: engine leases and the default project
// ---------------------------------------------------------------------------

describe('O3: a root reopened during its release keeps one lease per open', { timeout: 60_000 }, () => {
  let workspace: string;
  let root: string;
  let engine: MCPEngine | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-lease-')));
    root = path.join(workspace, 'repo');
    makeRepo(root);
    await indexDir(root);
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    __setLoadCodeGraphForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  async function search(handler: ToolHandler): Promise<ToolResult> {
    return handler.execute('codegraph_search', { projectPath: root, query: 'appSymbol' });
  }

  it('both leases are released: the writer slot and the database are freed on the second release', async () => {
    engine = new MCPEngine({ watch: true });
    const handler = engine.getToolHandler();
    const first = await search(handler);
    expect(first.isError).toBeFalsy();
    await vi.waitFor(() => expect(readWriterLock(root)?.pid).toBe(process.pid), { timeout: 5000 });

    // Hold the next call in flight before it resolves its project, so the
    // release below waits for it (the handler counts calls, not calls per
    // project) and the call then reopens the root the release took out.
    const seedHook = handler as unknown as { seedWorktreeIndex(p: string): Promise<void> };
    const original = seedHook.seedWorktreeIndex.bind(handler);
    const hold = new Gate();
    const entered = new Gate();
    vi.spyOn(seedHook, 'seedWorktreeIndex').mockImplementation(async (p: string) => {
      entered.open();
      await hold.promise;
      return original(p);
    });
    const held = search(handler);
    await entered.promise;

    const firstRelease = engine.releaseProjectRoot(root);
    await new Promise((r) => setImmediate(r));
    expect(cachedRoots(handler)).not.toContain(root);

    hold.open();
    const reopened = await held;
    expect(reopened.isError).toBeFalsy();
    expect(reopened.content[0].text).toContain('appSymbol');
    await firstRelease;
    // The call that reopened it still holds it.
    expect(cachedRoots(handler)).toContain(root);
    vi.mocked(seedHook.seedWorktreeIndex).mockRestore();

    await engine.releaseProjectRoot(root);
    expect(cachedRoots(handler)).not.toContain(root);
    expect(readWriterLock(root)?.pid).not.toBe(process.pid);
    if (HAS_LSOF) expect(openFdCount([dbFile(root), `${dbFile(root)}-wal`])).toBe(0);

    // A later call opens a live graph, not the one the release closed.
    const again = await search(handler);
    expect(again.isError).toBeFalsy();
    expect(again.content[0].text).toContain('appSymbol');
  });
});

describe('O5: a removed worktree serving as the default project is freed by one pass', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let wt: string;
  let engine: DistEngine | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-default-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
    await indexDir(main);
    wt = path.join(workspace, 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    expect((await ensureWorktreeIndex(wt)).kind).toBe('seeded');
    // A server whose session started in the seeded worktree: its default
    // project. The built engine, because the default open requires
    // '../index', which vitest cannot resolve from src/mcp.
    engine = new DistMCPEngine({ watch: true });
    await engine.ensureInitialized(wt);
    expect(engine.hasDefaultCodeGraph()).toBe(true);
    await vi.waitFor(() => expect(readWriterLock(wt)?.pid).toBe(process.pid), { timeout: 5000 });
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  // The sweep's release of the default project retires it: the engine lets
  // go of its lease (watcher, database, writer slot) and serves on with no
  // default project. The server is opened in beforeEach, so a failure to
  // open it fails the hook, never this case.
  it('a server started in the seeded worktree releases it once it is removed', async () => {
    const files = [dbFile(wt), `${dbFile(wt)}-wal`];
    git(main, 'worktree', 'remove', '--force', wt);
    expect(fs.existsSync(wt)).toBe(false);
    await engine!.runHousekeepingTick();

    expect(getRegisteredProject(wt)).toBeNull();
    expect(engine!.hasDefaultCodeGraph()).toBe(false);
    if (HAS_LSOF) expect(openFdCount(files)).toBe(0);
    // Retiring the default recreated nothing at the removed path.
    expect(fs.existsSync(wt)).toBe(false);
  });
});

describe('O5: a retired default is re-adopted only as itself', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let wt: string;
  let engine: DistEngine | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-readopt-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
    await indexDir(main);
    // Nested inside the indexed main checkout, as agent worktrees often are:
    // a walk up from the removed worktree reaches main's index.
    wt = path.join(main, '.worktrees', 'nested');
    git(main, 'worktree', 'add', '-q', '-b', 'nested', wt);
    expect((await ensureWorktreeIndex(wt)).kind).toBe('seeded');
    engine = new DistMCPEngine({ watch: true });
    await engine.ensureInitialized(wt);
    expect(engine.getProjectPath()).toBe(wt);
    await vi.waitFor(() => expect(readWriterLock(wt)?.pid).toBe(process.pid), { timeout: 5000 });
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  it('the per-call retry never adopts the checkout above it, and adopts the same root once it is indexed again', async () => {
    git(main, 'worktree', 'remove', '--force', wt);
    await engine!.runHousekeepingTick();
    expect(engine!.hasDefaultCodeGraph()).toBe(false);

    // What each tool call without projectPath retries (session.ts): a walk up
    // from the retired root would find main's index.
    engine!.retryInitializeSync(wt);
    expect(engine!.hasDefaultCodeGraph()).toBe(false);
    await engine!.ensureInitialized(wt);
    expect(engine!.hasDefaultCodeGraph()).toBe(false);
    expect(readWriterLock(main)?.pid).not.toBe(process.pid);

    // The same worktree back, with an index of its own: that is re-adopted.
    git(main, 'worktree', 'add', '-q', wt, 'nested');
    expect((await ensureWorktreeIndex(wt)).kind).toBe('seeded');
    engine!.retryInitializeSync(wt);
    expect(engine!.hasDefaultCodeGraph()).toBe(true);
    expect(engine!.getProjectPath()).toBe(wt);
    await vi.waitFor(() => expect(readWriterLock(wt)?.pid).toBe(process.pid), { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// O4: query pool release waits for retiring workers
// ---------------------------------------------------------------------------

interface CallMsg { type: 'call'; id: number; args: Record<string, unknown> }

/**
 * Fake pool worker. Calls wait on `gates[i]` (by the call's `i` arg); a
 * `release` is acked at once; a `retire` is never answered: the worker
 * "exits" only when the test calls `exit()`, standing in for a retiring
 * worker that has not closed its connections yet.
 */
class HoldingFake implements PoolWorker {
  readonly posted: { type?: string }[] = [];
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  constructor(private readonly gates: Gate[]) {
    setTimeout(() => this.msgCb?.({ type: 'ready', ok: true }), 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
  }
  get retired(): boolean { return this.posted.some((m) => m.type === 'retire'); }
  private exited = false;
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.(0);
  }
  postMessage(msg: unknown): void {
    const m = msg as { type?: string; id?: number };
    this.posted.push(m);
    if (m.type === 'release') {
      setTimeout(() => this.msgCb?.({ type: 'released', id: m.id, ok: true }), 0);
      return;
    }
    if (m.type !== 'call') return;
    const call = msg as CallMsg;
    const i = (call.args as { i: number }).i;
    void this.gates[i].promise.then(() => {
      setTimeout(() => this.msgCb?.({ type: 'result', id: call.id, result: { content: [{ type: 'text', text: `r${i}` }] } }), 0);
    });
  }
  terminate(): Promise<number> { return Promise.resolve(1); }
}

describe('O4: QueryPool.releaseProject waits for a retiring worker to exit', () => {
  let pool: QueryPool | null = null;
  let fakes: HoldingFake[] = [];

  afterEach(async () => {
    // destroy() waits for every retiring worker: let any still held go.
    for (const f of fakes) if (f.retired) f.exit();
    await pool?.destroy();
    pool = null;
    fakes = [];
  });

  it('does not resolve while a retiring worker still runs, and resolves once it exits', async () => {
    const gates = [new Gate(), new Gate()];
    pool = new QueryPool({
      root: null, size: 2, idleTimeoutMs: 50, startSettleMs: 30_000,
      createWorker: () => { const f = new HoldingFake(gates); fakes.push(f); return f; },
    });
    // Grow to two workers, then let both go idle: one retires.
    const calls = [0, 1].map((i) => pool!.run('codegraph_search', { i }));
    await vi.waitFor(() => expect(pool!.liveWorkers).toBe(2));
    gates[0].open();
    gates[1].open();
    await Promise.all(calls);
    await vi.waitFor(() => expect(fakes.filter((f) => f.retired)).toHaveLength(1), { timeout: 5000 });
    const retiring = fakes.find((f) => f.retired)!;
    const live = fakes.find((f) => !f.retired)!;

    let settled = false;
    const release = pool.releaseProject('/some/root').then(() => { settled = true; });
    await vi.waitFor(() => expect(live.posted.some((m) => m.type === 'release')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    retiring.exit();
    await release;
    expect(settled).toBe(true);
  });
});
