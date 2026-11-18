/**
 * Follow-ups to the worktree lifecycle gates.
 *
 * F2 cross-process release: the first process to sweep a gone worktree
 *    unregisters it, so every other process's sweep no longer sees it. Each
 *    engine's housekeeping tick therefore also releases its OWN cached
 *    roots whose directory or `.codegraph/codegraph.db` is gone,
 *    through MCPEngine.releaseProjectRoot.
 *    Two MCPEngines in one process stand in for two server processes: each
 *    opens its own read-only handle on the root, so engine A's release leaves
 *    B's database handle open until B's own tick lets go. Engine A has an
 *    index builder; B has none, as the proxy's in-process fallback has none.
 *    The tick is `MCPEngine.runHousekeepingTick(): Promise<void>`: one
 *    housekeeping pass run now, whatever CODEGRAPH_HOUSEKEEPING_INTERVAL_MS
 *    says (the timers are off here so only the explicit calls act).
 * F3 a cold-built worktree is registered SEEDED with its git common dir and
 *    the seed nonce the builder wrote into the index, so teardown reclaims it
 *    like a seeded one.
 * F4 a seeder killed mid-copy leaves `codegraph.db.seed-<pid>-<hex>.tmp`;
 *    the next seed of that worktree removes the ones whose pid is dead.
 * F5 a worktree whose own index is not 'complete' and whose rebuild.pid
 *    holder is dead (a killed cold build) is treated as unindexed: its partial
 *    `.codegraph` is discarded and it is seeded, or cold-built, again. A cold
 *    build the builder's death killed does not mark the root failed: the
 *    restarted builder builds it again.
 *
 * Real git worktrees and real SQLite in mkdtemp dirs, driven through the
 * ToolHandler of an MCPEngine with a real index builder process (the shipped
 * entry point). The builder is the compiled dist/extensions/host/builder/main.js,
 * which the suite's global setup rebuilds when src/ changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests, type ToolHandler } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';
import { buildingNote, unseededWorktreeNote } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import {
  PROJECT_FLAG_SEEDED,
  getRegisteredProject,
  listRegisteredProjects,
  readSeedNonce,
  registerProject,
  stampSeedNonce,
  unregisterProject,
} from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { sweepWorktrees } from '../../../src/extensions/host/worktree-lifecycle/teardown';

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v']).error === undefined;

/**
 * A pid no process has: above macOS's pid range (max 99998). Linux allows pids
 * up to 4194304, so the cases that rely on it assert it is dead first.
 */
const DEAD_PID = 999999;

const NOT_INDEXED = "isn't indexed with codegraph";

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A repository with three small files, or `extra` more for a build long enough to interrupt. */
function makeRepo(dir: string, extra = 0): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'export function alphaSymbol() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'beta.ts'), 'export function betaSymbol() { return 2; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'gamma.ts'), 'export function gammaSymbol() { return 3; }\n');
  for (let i = 0; i < extra; i++) {
    const body = Array.from({ length: 20 }, (_, j) => `export function fill${i}_${j}(x: number) { return x + ${j}; }`).join('\n');
    fs.writeFileSync(path.join(dir, 'src', `fill${i}.ts`), `${body}\n`);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  try { await cg.indexAll(); } finally { cg.close(); }
}

function addWorktree(repo: string, dir: string, branch: string): void {
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
}

function dbFile(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
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

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return check();
}

function builderLog(stateDir: string): string[] {
  try {
    return fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

function coldBuildOkCount(stateDir: string, root: string): number {
  return builderLog(stateDir).filter((l) => l.endsWith(` job end cold-build ${root} ok`)).length;
}

type FileRow = { path: string; content_hash: string; indexed_at: number };

function fileRows(root: string): FileRow[] {
  const db = new DatabaseSync(dbFile(root), { readOnly: true });
  try {
    return db.prepare('SELECT path, content_hash, indexed_at FROM files ORDER BY path').all() as FileRow[];
  } finally {
    db.close();
  }
}

function indexState(root: string): string | null {
  const db = new DatabaseSync(dbFile(root), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'index_state'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * What a cold build killed mid-index leaves: a database with the schema and
 * no rows, `index_state` 'indexing', and a `rebuild.pid` naming a dead pid.
 */
function plantPartialIndex(root: string): void {
  CodeGraph.initSync(root).close();
  const db = new DatabaseSync(dbFile(root));
  try {
    db.prepare("INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES ('index_state', 'indexing', ?)").run(Date.now());
  } finally {
    db.close();
  }
  fs.writeFileSync(
    path.join(root, '.codegraph', 'rebuild.pid'),
    JSON.stringify({ pid: DEAD_PID, mode: 'cold-build', startedAt: Date.now(), root: real(root) }) + '\n',
  );
}

function clearRegistry(): void {
  for (const p of listRegisteredProjects()) unregisterProject(p.root);
}

// ---------------------------------------------------------------------------
// F2: cross-process release
// ---------------------------------------------------------------------------

type TickingEngine = MCPEngine & { runHousekeepingTick?: () => Promise<void> };

// slow: each case builds two indexes and starts a builder; condition waits allow engine loading and
// writer acquisition under load, while the outer bound catches a hang.
describe('F2: an engine releases its own cached roots another process tore down', { timeout: 600_000 }, () => {
  let workspace: string;
  let main: string;
  let commonDir: string;
  let engineA: MCPEngine | undefined;
  let engineB: TickingEngine | undefined;
  let builderA: BuilderClient | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    // No timers: only the explicit sweep (A) and tick (B) act on the roots.
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-followup-release-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    main = path.join(workspace, 'main');
    makeRepo(main);
    commonDir = real(path.resolve(main, git(main, 'rev-parse', '--git-common-dir')));
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    await engineA?.stop();
    await engineB?.stop();
    await builderA?.stop();
    engineA = undefined;
    engineB = undefined;
    builderA = undefined;
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  async function open(handler: ToolHandler, root: string, query: string): Promise<void> {
    const res = await handler.execute('codegraph_search', { projectPath: root, query }, undefined, ADMIT_ALL);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(query);
    expect(cachedRoots(handler)).toContain(root);
  }

  /**
   * Seeded worktree `name` plus the live `main`, both opened by engines A and
   * B. The worktree is registered as a seed leaves it: a seed nonce written
   * into its index by the product's own writer, and the same nonce recorded.
   */
  async function setUp(name: string): Promise<string> {
    const wt = path.join(workspace, name);
    addWorktree(main, wt, name);
    await indexDir(wt);
    await indexDir(main);
    const seedNonce = stampSeedNonce(dbFile(wt));
    registerProject(wt, { seeded: true, commonDir, seedNonce });
    expect(readSeedNonce(wt)).toBe(seedNonce);

    // A has the index builder (so it is the writer's server); B reads only, with no builder.
    builderA = BuilderClient.start();
    expect(await waitUntil(() => builderA?.isUp() === true, 180_000)).toBe(true);
    engineA = new MCPEngine({ builder: builderA });
    engineB = new MCPEngine({}) as TickingEngine;
    await open(engineA.getToolHandler(), wt, 'alphaSymbol');
    await open(engineB.getToolHandler(), wt, 'alphaSymbol');
    await open(engineB.getToolHandler(), main, 'betaSymbol');
    expect(await waitUntil(() => readWriterLock(wt)?.pid === builderA?.pid(), 180_000)).toBe(true);
    return wt;
  }

  async function sweepByA(wt: string): Promise<void> {
    const a = engineA!;
    const torn = await sweepWorktrees({ release: (root) => a.releaseProjectRoot(root) });
    expect(torn).toEqual([wt]);
    expect(getRegisteredProject(wt)).toBeNull();
    expect(cachedRoots(a.getToolHandler())).not.toContain(wt);
  }

  async function expectBReleasedOnly(wt: string): Promise<void> {
    const handlerB = engineB!.getToolHandler();
    // B never saw the registry entry; only its own tick can let go.
    await engineB!.runHousekeepingTick?.();
    expect(cachedRoots(handlerB)).not.toContain(wt);
    // A's release made the builder let go of the root's writer slot.
    expect(readWriterLock(wt)).toBeNull();
    if (HAS_LSOF) expect(openFdCount([dbFile(wt), `${dbFile(wt)}-wal`])).toBe(0);
    // A live root B also holds stays open.
    expect(cachedRoots(handlerB)).toContain(main);
  }

  it('after A sweeps a worktree removed with git worktree remove, B\'s next tick releases it', async () => {
    const wt = await setUp('gone');
    // --force: CodeGraph's .codegraph/.gitignore is an untracked file.
    git(main, 'worktree', 'remove', '--force', wt);
    expect(fs.existsSync(wt)).toBe(false);
    await sweepByA(wt);
    await expectBReleasedOnly(wt);
  });

  it('after A sweeps a pruned worktree and deletes its index, B\'s next tick releases it', async () => {
    const wt = await setUp('pruned');
    fs.rmSync(path.join(wt, '.git'), { force: true });
    git(main, 'worktree', 'prune');
    await sweepByA(wt);
    // The directory stays; its database is what is gone.
    expect(fs.existsSync(path.join(wt, 'src', 'alpha.ts'))).toBe(true);
    expect(fs.existsSync(dbFile(wt))).toBe(false);
    await expectBReleasedOnly(wt);
  });
});

// ---------------------------------------------------------------------------
// F3, F4, F5: seeding and cold builds through the engine's handler
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'CODEGRAPH_NO_AUTO_SEED',
  'CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS',
  'CODEGRAPH_HOUSEKEEPING_INTERVAL_MS',
  'CODEGRAPH_WATCH_DEBOUNCE_MS',
  'CODEGRAPH_STATE_DIR',
] as const;

// Every case builds an index, waits out a catch-up sync, or waits for a cold
// build on the index builder (process start + index). The killed-build case also
// waits for the restarted builder's readiness; the bounds catch hangs under load.
describe('F3-F5: seeding and cold builds through the engine', { timeout: 600_000 }, () => {
  let workspace: string;
  let main: string;
  let engine: MCPEngine;
  let builder: BuilderClient;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.CODEGRAPH_NO_AUTO_SEED;
    process.env.CODEGRAPH_HOUSEKEEPING_INTERVAL_MS = '0';
    process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '100';
    // Wait for each explicit project's catch-up sync, so a case sees what the
    // catch-up left behind (as worktree-seed.gate.test.ts does).
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-followup-seed-')));
    // The builder's own state dir; the builder inherits the environment set above.
    process.env.CODEGRAPH_STATE_DIR = path.join(workspace, 'state');
    main = path.join(workspace, 'main');
    __setLoadCodeGraphForTests(CodeGraph);
    builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
  }, 180_000);

  afterEach(async () => {
    await engine.stop();
    await builder.stop();
    __setLoadCodeGraphForTests(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  async function search(projectPath: string, query: string): Promise<{ text: string; isError: boolean }> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query, projectPath }, undefined, ADMIT_ALL);
    return { text: res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'), isError: Boolean(res.isError) };
  }

  /** Poll until the root answers from a finished index; every answer meanwhile is success-shaped. */
  async function waitForAnswer(root: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await search(root, 'alphaSymbol');
      expect(res.isError).toBe(false);
      if (res.text.includes('src/alpha.ts')) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await waitUntil(() => !fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid')), 180_000)).toBe(true);
  }

  // slow: waits for a builder cold start and a real cold build of three files.
  it('F3: a cold-built worktree is registered SEEDED with its common dir and seed nonce', async () => {
    makeRepo(main);
    const wt = path.join(workspace, 'wt-cold');
    addWorktree(main, wt, 'cold');
    const first = await search(wt, 'alphaSymbol');
    expect(first.text).toContain(buildingNote(real(wt)));
    await waitForAnswer(wt, 180_000);

    const rec = getRegisteredProject(real(wt));
    expect(rec).not.toBeNull();
    expect(rec!.flags & PROJECT_FLAG_SEEDED).not.toBe(0);
    expect(rec!.commonDir).toBe(real(path.join(main, '.git')));
    // The builder wrote a seed nonce into the index it built and recorded it.
    expect(rec!.seedNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(readSeedNonce(real(wt))).toBe(rec!.seedNonce);
  });

  // slow: indexes the sibling and waits for the builder process to seed the worktree.
  it('F4: a seed removes a dead seeder\'s leftover temp file and keeps a live one\'s', async () => {
    makeRepo(main);
    await indexDir(main);
    const wt = path.join(workspace, 'wt-leftover');
    addWorktree(main, wt, 'leftover');
    // What a seeder killed mid-copy leaves: the .gitignore it wrote first and
    // its staged copy, with no database installed yet.
    const dir = path.join(wt, '.codegraph');
    fs.mkdirSync(dir);
    fs.copyFileSync(path.join(main, '.codegraph', '.gitignore'), path.join(dir, '.gitignore'));
    expect(pidAlive(DEAD_PID)).toBe(false);
    const dead = path.join(dir, `codegraph.db.seed-${DEAD_PID}-deadbeef.tmp`);
    fs.writeFileSync(dead, 'partial copy');
    // The parent of this test process is alive: its staging file may be in use.
    const live = path.join(dir, `codegraph.db.seed-${process.ppid}-cafef00d.tmp`);
    fs.writeFileSync(live, 'in progress');

    const res = await search(wt, 'alphaSymbol');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('src/alpha.ts');
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  // slow: indexes the sibling, starts the builder, seeds and catches up the worktree.
  it('F5: a partial index with a dead rebuild.pid is discarded and the worktree seeded from its sibling', async () => {
    makeRepo(main);
    await indexDir(main);
    const wt = path.join(workspace, 'wt-partial');
    addWorktree(main, wt, 'partial');
    plantPartialIndex(wt);

    const res = await search(wt, 'alphaSymbol');
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(NOT_INDEXED);
    expect(res.text).toContain('src/alpha.ts');
    // Seeded: every files row is the sibling's own, indexed_at included, not
    // a fresh index of the same content into the partial database.
    expect(fileRows(wt)).toEqual(fileRows(main));
    expect(indexState(wt)).toBe('complete');
    expect(fs.existsSync(path.join(wt, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(getRegisteredProject(real(wt))!.flags & PROJECT_FLAG_SEEDED).not.toBe(0);
  });

  // The 150 generated files make the first build long enough to interrupt.
  it('F5: a cold build killed with its builder by SIGKILL is built again by the restarted builder, not marked failed', async () => {
    makeRepo(main, 150);
    const wt = path.join(workspace, 'wt-killed');
    addWorktree(main, wt, 'killed');
    const root = real(wt);
    const stateDir = path.join(workspace, 'state');
    const first = await search(wt, 'alphaSymbol');
    expect(first.text).toContain(buildingNote(root));

    // The cold build's job child takes rebuild.pid before it creates the database;
    // poll for it so the kill has a chance to interrupt the build.
    let pid: number | null = null;
    expect(await waitUntil(() => {
      pid = readWriterLock(root, 'rebuild.pid')?.pid ?? null;
      return pid !== null;
    }, 180_000, 5)).toBe(true);
    // Each builder job runs in its own child process, so rebuild.pid names that live child, not the builder.
    const child = pid!;
    expect(child).not.toBe(builder.pid());
    expect(pidAlive(child)).toBe(true);
    // Kill the builder, then its job child: the builder's death closes the child's channel and the child exits on
    // its own (job-child-main.ts), so it may already be gone. Its rebuild.pid, naming a dead pid, is left for the
    // restarted builder's dead-holder check.
    const killed = builder.pid()!;
    process.kill(killed, 'SIGKILL');
    try { process.kill(child, 'SIGKILL'); } catch { /* already exited */ }
    expect(await waitUntil(() => !pidAlive(killed) && !pidAlive(child), 180_000, 20)).toBe(true);
    // No successful job end is logged after the kill; a later ok line and
    // complete index provide evidence of the restarted builder's work.
    expect(coldBuildOkCount(stateDir, root)).toBe(0);
    expect(await waitUntil(() => builder.pid() !== null && builder.pid() !== killed, 180_000, 20)).toBe(true);
    // A forked pid is not readiness: wait until the restarted builder has loaded its engine.
    expect(await waitUntil(() => builder.isUp(), 180_000, 20)).toBe(true);

    // The builder process runs async git with GIT_ASYNC_TIMEOUT_MS (5 s). A lookup timeout is pending
    // preparation, never a failed build. Observe building guidance without accepting failure guidance.
    expect(await waitUntil(async () => {
      const again = await search(wt, 'alphaSymbol');
      expect(again.isError).toBe(false);
      expect(again.text).not.toContain(unseededWorktreeNote(wt, root));
      expect(again.text).not.toContain('the build failed');
      return again.text.includes(buildingNote(root));
    }, 180_000)).toBe(true);
    // An answer, a gone rebuild.pid, complete state, and an ok job line after
    // the kill together check that the restarted builder completed the build.
    await waitForAnswer(wt, 180_000);
    expect(indexState(wt)).toBe('complete');
    expect(await waitUntil(() => coldBuildOkCount(stateDir, root) >= 1, 180_000)).toBe(true);
  }, 1_200_000);
});
