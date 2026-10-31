/**
 * Worktree teardown and query-pool release.
 *
 * G11: src/extensions/host/worktree-lifecycle/teardown.ts `sweepWorktrees(deps)` finds registered
 * roots that are gone (directory missing, or no longer listed by
 * `git worktree list` of their repository, located from the root's `.git` file
 * or the recorded common dir) and tears each down: deps.release(root), then,
 * judged gone once more under the record lock, delete `<root>/.codegraph` only when the registry says it was
 * SEEDED, the directory still exists, and the database there holds the seed
 * nonce the record holds, and unregister. deps.release here is
 * ToolHandler.releaseProjectRoot on a handler whose ProjectLifecycle is the one
 * MCPEngine installs (src/mcp/engine.ts constructor), with a real index builder
 * behind the engine, so the test sees all three effects of a release: the
 * handler's cache, the builder's writer.pid and this process's open SQLite
 * files.
 *
 * The seeded index is planted by hand, the way a seed leaves it: a tiny real
 * index built in the worktree, a seed nonce written into it by the product's
 * own writer (stampSeedNonce), and registerProject(root, { seeded: true,
 * commonDir, seedNonce }). So these tests do not depend on the copy code.
 * Seeding and the engine's own housekeeping timer are switched off so nothing
 * but the explicit sweep acts on the roots.
 *
 * G13: QueryPool.releaseProject(root) posts `{ type: 'release', id, root }`
 * to every worker; a worker closes that project through its handler and acks
 * `{ type: 'released', id, ok }`.
 * Runs the BUILT pool and worker (dist/mcp/), as query-pool-idle.test.ts does,
 * so dist/ must be rebuilt (`npm run build`) after the pool and worker change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { MCPEngine } from '../../../src/mcp/engine';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import type { QueryPool } from '../../../src/mcp/query-pool';
import type { ToolHandler } from '../../../src/mcp/tools';

type Registry = typeof import('../../../src/extensions/host/worktree-lifecycle/project-registry');
type Teardown = typeof import('../../../src/extensions/host/worktree-lifecycle/teardown');
const loadRegistry = (): Promise<Registry> => import('../../../src/extensions/host/worktree-lifecycle/project-registry');
const loadTeardown = (): Promise<Teardown> => import('../../../src/extensions/host/worktree-lifecycle/teardown');

const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v']).error === undefined;

/** This process's open fds on exactly these files, per `lsof -p <pid> -Fn`. */
function openFdCount(files: string[]): number {
  const out = spawnSync('lsof', ['-p', String(process.pid), '-Fn'], { encoding: 'utf8' }).stdout ?? '';
  const wanted = new Set(files);
  return out.split('\n').filter((l) => l.startsWith('n') && wanted.has(l.slice(1))).length;
}

function dbFiles(root: string): string[] {
  const db = path.join(root, '.codegraph', 'codegraph.db');
  return [db, `${db}-wal`];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Roots the handler holds open: its private per-project cache, read structurally. */
function cachedRoots(handler: ToolHandler): string[] {
  const cache = (handler as unknown as { projectCache?: unknown }).projectCache;
  return cache instanceof Map ? [...cache.keys()] as string[] : [];
}

async function buildIndex(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  try { await cg.indexAll(); } finally { cg.close(); }
}

describe('sweepWorktrees tears down gone worktrees (G11)', () => {
  let tempDir: string;
  let main: string;
  let commonDir: string;
  let engine: MCPEngine | undefined;
  let builder: BuilderClient | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    // Realpath'd, so every root below is already canonical (macOS /var).
    // os.tmpdir() is not inside a git repository, so a directory under it that
    // stops being a worktree is not a repository at all.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-teardown-')));
    main = path.join(tempDir, 'main');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'app.ts'), 'export function appSymbol() { return 42; }\n');
    git(main, 'add', 'app.ts');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
    commonDir = fs.realpathSync(path.resolve(main, git(main, 'rev-parse', '--git-common-dir')));
    // The handler loads CodeGraph lazily from '../index', which vitest cannot
    // resolve from src/mcp: hand it the class, as worktree-seed.gate.test.ts does.
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    await builder?.stop();
    builder = undefined;
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(path.join(os.homedir(), '.codegraph', 'projects'), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** A worktree of main on its own branch, with a real index built in it. */
  async function addIndexedWorktree(name: string): Promise<string> {
    const wt = path.join(tempDir, name);
    git(main, 'worktree', 'add', '-q', '-b', name, wt);
    await buildIndex(wt);
    return wt;
  }

  /** Register `wt` as a seed leaves it: a seed nonce in its index, and the same one in its record. */
  function registerSeeded(reg: Registry, wt: string): void {
    const seedNonce = reg.stampSeedNonce(dbFiles(wt)[0]!);
    reg.registerProject(wt, { seeded: true, commonDir, seedNonce });
    expect(reg.readSeedNonce(wt)).toBe(seedNonce);
  }

  /** An engine with a real index builder behind it (stopped after the engine, in afterEach). */
  function engineWithBuilder(): MCPEngine {
    builder = BuilderClient.start();
    return new MCPEngine({ builder });
  }

  /** Open `root` through the engine's handler and wait until the builder is its writer. */
  async function openThroughHandler(handler: ToolHandler, root: string): Promise<void> {
    const res = await handler.execute('codegraph_search', { projectPath: root, query: 'appSymbol' }, undefined, ADMIT_ALL);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('appSymbol');
    expect(cachedRoots(handler)).toContain(root);
    await vi.waitFor(() => expect(readWriterLock(root)?.pid).toBe(builder!.pid()), { timeout: 5000 });
    if (HAS_LSOF) expect(openFdCount(dbFiles(root))).toBeGreaterThan(0);
  }

  /** Make `wt` stop being a worktree while its directory stays: drop its .git link and prune. */
  function pruneKeepingDir(wt: string): void {
    fs.rmSync(path.join(wt, '.git'), { force: true });
    git(main, 'worktree', 'prune');
    expect(git(main, 'worktree', 'list', '--porcelain')).not.toContain(wt);
  }

  function expectReleased(handler: ToolHandler, root: string): void {
    expect(cachedRoots(handler)).not.toContain(root);
    // The builder let go of its hold: no writer.pid names anyone (the directory may be gone, or the index deleted).
    expect(readWriterLock(root)).toBeNull();
    if (HAS_LSOF) expect(openFdCount(dbFiles(root))).toBe(0);
  }

  // 30 s timeout (1.5 s alone): a real index builder process starts and holds the worktree, which on a
  // machine at load 16-29, with the host folder running beside it, takes more than the 5 s default.
  it('releases and unregisters a seeded worktree removed with git worktree remove', { timeout: 30_000 }, async () => {
    const reg = await loadRegistry();
    const { sweepWorktrees } = await loadTeardown();
    const wt = await addIndexedWorktree('gone');
    registerSeeded(reg, wt);

    engine = engineWithBuilder();
    const handler = engine.getToolHandler();
    await openThroughHandler(handler, wt);

    // --force: CodeGraph's .codegraph/.gitignore is an untracked file.
    git(main, 'worktree', 'remove', '--force', wt);
    expect(fs.existsSync(wt)).toBe(false);

    const torn = await sweepWorktrees({ release: (root) => handler.releaseProjectRoot(root) });
    expect(torn).toEqual([wt]);
    expectReleased(handler, wt);
    expect(reg.getRegisteredProject(wt)).toBeNull();
  });

  // 30 s timeout, for the same reason as the test above.
  it('deletes the index of a seeded worktree pruned while its directory remains', { timeout: 30_000 }, async () => {
    const reg = await loadRegistry();
    const { sweepWorktrees } = await loadTeardown();
    const wt = await addIndexedWorktree('pruned');
    registerSeeded(reg, wt);

    engine = engineWithBuilder();
    const handler = engine.getToolHandler();
    await openThroughHandler(handler, wt);

    pruneKeepingDir(wt);

    const torn = await sweepWorktrees({ release: (root) => handler.releaseProjectRoot(root) });
    expect(torn).toEqual([wt]);
    expectReleased(handler, wt);
    expect(fs.existsSync(path.join(wt, '.codegraph'))).toBe(false);
    // Only the index goes: the directory and the user's files stay.
    expect(fs.existsSync(path.join(wt, 'app.ts'))).toBe(true);
    expect(reg.getRegisteredProject(wt)).toBeNull();
  });

  it('never deletes the index of a non-seeded root, and leaves a live root registered', async () => {
    const reg = await loadRegistry();
    const { sweepWorktrees } = await loadTeardown();
    const plain = await addIndexedWorktree('plain');
    await buildIndex(main);
    reg.registerProject(plain, { commonDir });
    reg.registerProject(main, { commonDir });

    pruneKeepingDir(plain);

    const released: string[] = [];
    const torn = await sweepWorktrees({ release: async (root) => { released.push(root); } });
    expect(torn).not.toContain(main);
    expect(released).not.toContain(main);
    expect(fs.existsSync(path.join(plain, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(reg.getRegisteredProject(main)).not.toBeNull();
  });

  // The machine server is one per state dir, not one per root: tearing a root
  // down touches only that root's index and registry record, never the
  // server's lock or socket (the server releases the root itself).
  it('leaves the machine server\'s lock and socket alone, and keeps its registry under the state dir', async () => {
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-teardown-state-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    const reg = await loadRegistry();
    const { sweepWorktrees } = await loadTeardown();
    const wt = await addIndexedWorktree('server-files');
    reg.registerProject(wt, { commonDir });
    expect(reg.registryDir()).toBe(path.join(stateDir, 'projects'));

    // Plain files stand in for a live server's lock and bound socket.
    const pidPath = path.join(stateDir, 'server.pid');
    const socketPath = path.join(stateDir, 'server.sock');
    try {
      fs.writeFileSync(pidPath, '{"pid":1}\n');
      fs.writeFileSync(socketPath, '');

      pruneKeepingDir(wt);

      const torn = await sweepWorktrees({ release: async () => { /* nothing held */ } });
      expect(torn).toEqual([wt]);
      expect(reg.getRegisteredProject(wt)).toBeNull();
      expect(fs.readFileSync(pidPath, 'utf8')).toBe('{"pid":1}\n');
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// The built pool, so its default worker factory loads the compiled worker sibling.
const BuiltQueryPool: typeof QueryPool = require('../../../dist/mcp/query-pool').QueryPool;

describe('QueryPool.releaseProject closes the root on its workers (G13)', () => {
  let tempDir: string;
  let pool: QueryPool | null = null;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pool-release-')));
  });

  afterEach(async () => {
    await pool?.destroy();
    pool = null;
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Can run past 5 s under load: it starts a real worker thread, which loads
  // the compiled engine and opens SQLite.
  it.runIf(HAS_LSOF)('a worker that served the root closes it on releaseProject and keeps serving', async () => {
    const beta = path.join(tempDir, 'beta');
    fs.mkdirSync(beta);
    fs.writeFileSync(path.join(beta, 'app.ts'), 'export function betaSymbol() { return 7; }\n');
    await buildIndex(beta);
    // No default project: the worker opens beta only because a call names it,
    // and this thread holds no connection to it, so every fd on beta's
    // database below is the worker's.
    expect(openFdCount(dbFiles(beta))).toBe(0);

    pool = new BuiltQueryPool({ root: null, size: 1, idleTimeoutMs: 0 });
    const first = await pool.run('codegraph_search', { projectPath: beta, query: 'betaSymbol' });
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toContain('betaSymbol');
    expect(openFdCount(dbFiles(beta))).toBeGreaterThan(0);

    await pool.releaseProject(beta);
    expect(openFdCount(dbFiles(beta))).toBe(0);
    expect(pool.liveWorkers).toBe(1);

    const again = await pool.run('codegraph_search', { projectPath: beta, query: 'betaSymbol' });
    expect(again.isError).toBeFalsy();
    expect(again.content[0].text).toContain('betaSymbol');
  }, 30000);
});
