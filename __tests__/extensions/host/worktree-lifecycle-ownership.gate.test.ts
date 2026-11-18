import { inProcessJobRunner } from './helpers/in-process-job-runner';
/**
 * Ownership and lifetime gates. Each case drives the shipped entry point and asserts what is
 * left on disk or which handles are still held, not names or return values.
 *
 * O1 cold build (`runColdBuild`, the builder's cold-build job): a failed build
 *    deletes only a database this process created. An index another
 *    initializer made between the build's own check and `CodeGraph.init`'s
 *    (init awaits the grammar load before it checks again, so the window is
 *    real) survives with its rows, whether init then throws "already
 *    initialized" or fails before it creates anything.
 * O2 teardown (`sweepWorktrees`): a seeded worktree removed and replaced, before
 *    a sweep, by a directory whose index the user built (another repository at
 *    the same path, or the same directory once it lost its .git). The seed
 *    wrote a nonce into the index it installed and the registry recorded it;
 *    the user's index carries none, so the sweep unregisters the root and
 *    leaves that index, rows and all.
 * O4 query pool (`QueryPool.releaseProject`): the release does not resolve
 *    while a retiring worker, which may still hold the root, has not exited.
 *
 * Real git repositories and real SQLite in mkdtemp dirs; O4 uses fake pool
 * workers, so the retiring worker's exit is in the test's hands. O3, the
 * engine release with the built index builder, is in
 * worktree-lifecycle-ownership.validation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { QueryPool, type PoolWorker } from '../../../src/mcp/query-pool';
import { getRegisteredProject, readSeedNonce } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { ensureWorktreeIndex } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { BuilderSeedHost } from '../../../src/extensions/host/builder/seed-host';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { sweepWorktrees } from '../../../src/extensions/host/worktree-lifecycle/teardown';
import { clearRegistry } from './helpers/clear-registry';
import { dbFile } from './helpers/db-file';
import { Gate } from './helpers/gate';
import { git } from './helpers/git';
import { indexDir } from './helpers/index-dir';
import { makeRepo } from './helpers/make-repo';
import { real } from './helpers/real';

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

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

// ---------------------------------------------------------------------------
// O1: a failed cold build deletes only what it created
// ---------------------------------------------------------------------------

describe('O1: a failed cold build never deletes an index someone else made', { timeout: 600_000, hookTimeout: 180_000 }, () => {
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
   * Hold CodeGraph.init (the build's own call) until another initializer has
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

  // slow: a real index is built during the competing initializer call, even under load.
  it('init throws "already initialized": the other initializer\'s index and rows survive', async () => {
    const user = userIndexesDuringInit('real-init');
    const code = await runColdBuild(root);
    expect(code).not.toBe(0);
    expect(fs.existsSync(dbFile(root))).toBe(true);
    expect(user.rows().nodes).toContain('appSymbol');
    expect(indexRows(root)).toEqual(user.rows());
    // The build released its fence and registered nothing: the index is not its.
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(getRegisteredProject(root)).toBeNull();
  });

  // slow: a real index is built during the competing initializer call, even under load.
  it('init fails before creating anything while the other index lands: that index survives', async () => {
    const user = userIndexesDuringInit('fail-before-create');
    const code = await runColdBuild(root);
    expect(code).not.toBe(0);
    expect(fs.existsSync(dbFile(root))).toBe(true);
    expect(indexRows(root)).toEqual(user.rows());
    expect(getRegisteredProject(root)).toBeNull();
  });

  // slow: real SQLite initialization precedes the injected indexing failure.
  it('an index the build created and failed to fill is still removed', async () => {
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

describe('O2: teardown never deletes an index the user built at a seeded root', { timeout: 600_000, hookTimeout: 180_000 }, () => {
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
    const outcome = await ensureWorktreeIndex(wt, new BuilderSeedHost(new JobQueue(), { runJob: inProcessJobRunner().runJob }));
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

    // slow: real repository seeding and re-indexing arrange a replaced index before the sweep.
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

    // slow: real repository seeding and re-indexing arrange a replaced index before the sweep.
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

describe('O4: QueryPool.releaseProject waits for a retiring worker to exit', { timeout: 600_000, hookTimeout: 180_000 }, () => {
  let pool: QueryPool | null = null;
  let fakes: HoldingFake[] = [];

  afterEach(async () => {
    // destroy() waits for every retiring worker: let any still held go.
    for (const f of fakes) if (f.retired) f.exit();
    await pool?.destroy();
    pool = null;
    fakes = [];
  });

  // slow under load: real worker-idle timers trigger retirement before the explicit exit releases the gate.
  it('does not resolve while a retiring worker still runs, and resolves once it exits', async () => {
    const gates = [new Gate(), new Gate()];
    pool = new QueryPool({
      root: null, size: 2, idleTimeoutMs: 50, startSettleMs: 180_000,
      createWorker: () => { const f = new HoldingFake(gates); fakes.push(f); return f; },
    });
    // Grow to two workers, then let both go idle: one retires.
    const calls = [0, 1].map((i) => pool!.run('codegraph_search', { i }));
    await vi.waitFor(() => expect(pool!.liveWorkers).toBe(2), { timeout: 180_000 });
    gates[0].open();
    gates[1].open();
    await Promise.all(calls);
    await vi.waitFor(() => expect(fakes.filter((f) => f.retired)).toHaveLength(1), { timeout: 180_000 });
    const retiring = fakes.find((f) => f.retired)!;
    const live = fakes.find((f) => !f.retired)!;

    let settled = false;
    const release = pool.releaseProject('/some/root').then(() => { settled = true; });
    await vi.waitFor(() => expect(live.posted.some((m) => m.type === 'release')).toBe(true), { timeout: 180_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    retiring.exit();
    await release;
    expect(settled).toBe(true);
  });
});
