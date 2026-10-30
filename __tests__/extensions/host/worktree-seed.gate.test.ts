/**
 * Worktree seeding through the tool-call entry point (request
 * worktree-lifecycle, unit U1).
 *
 * An agent working in a fresh git worktree passes that worktree as
 * `projectPath`. When another worktree of the same repository already has an
 * index, the first call seeds the new worktree's index from it and answers,
 * instead of telling the agent the project is not indexed. A worktree with no
 * indexed sibling keeps the not-indexed guidance unless the user opted in to
 * a cold build. `CODEGRAPH_NO_AUTO_SEED=1` restores the old behaviour. A
 * pinned project is never released by the handler's idle timer or its LRU
 * bound.
 *
 * G2/G3/G7/G8 drive a real MCPEngine (the ToolHandler with the
 * ProjectLifecycle the engine wires) against real git worktrees and real
 * SQLite. G10 drives a ToolHandler whose lifecycle hands out stand-ins, as
 * mcp-idle-release-order.test.ts does, so only the cache policy is under test.
 *
 * Vectors (contract.md): G2, G3, G7, G8, the pinned half of G10.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { ToolHandler, MAX_CACHED_PROJECTS, __setLoadCodeGraphForTests, type ProjectLifecycle } from '../../../src/mcp/tools';
import { buildingNote } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { pinProject, registerProject, unregisterProject, listRegisteredProjects } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

// vite's resolver strips the `node:` prefix from an import of node:sqlite,
// so it is loaded with require (as the upstream suites do).
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}

function makeRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'export function alphaSymbol() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'beta.ts'), 'export function betaSymbol() { return 2; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'gamma.ts'), 'export function gammaSymbol() { return 3; }\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function indexDir(dir: string): Promise<void> {
  const cg = await CodeGraph.init(dir);
  await cg.indexAll();
  cg.close();
}

function addWorktree(repo: string, dir: string, branch: string): void {
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
}

const NOT_INDEXED = "isn't indexed with codegraph";

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

const ENV_KEYS = [
  'CODEGRAPH_AUTO_INDEX',
  'CODEGRAPH_NO_AUTO_SEED',
  'CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS',
  'CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS',
  'CODEGRAPH_WATCH_DEBOUNCE_MS',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearRegistry(): void {
  for (const p of listRegisteredProjects()) unregisterProject(p.root);
}

// Every case builds an index or waits out a catch-up sync on real files; the
// hook and case bounds only catch a hang on a loaded machine.
describe('worktree seeding at the tool-call entry point', { timeout: 60_000 }, () => {
  let workspace: string;
  let main: string;
  let engine: MCPEngine;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = snapshotEnv();
    delete process.env.CODEGRAPH_AUTO_INDEX;
    delete process.env.CODEGRAPH_NO_AUTO_SEED;
    process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '100';
    // Wait for each explicit project's catch-up sync instead of the gate's
    // serve-anyway deadline, so a case sees what the catch-up left behind.
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-seed-gate-')));
    main = path.join(workspace, 'main');
    makeRepo(main);
    __setLoadCodeGraphForTests(CodeGraph);
    engine = new MCPEngine({ watch: true });
    // A root with nothing indexed at or below it: no default project, so every
    // call goes through the explicit-projectPath path.
    const emptyRoot = path.join(workspace, 'empty-root');
    fs.mkdirSync(emptyRoot);
    await engine.ensureInitialized(emptyRoot);
  }, 60_000);

  afterEach(async () => {
    await engine.stop();
    __setLoadCodeGraphForTests(null);
    restoreEnv(saved);
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  async function search(projectPath: string, query: string): Promise<{ text: string; isError: boolean }> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query, projectPath });
    return { text: res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'), isError: Boolean(res.isError) };
  }

  // G2. Indexes the sibling and seeds plus catches up the new worktree; ~2 s.
  it('G2: a fresh worktree with an indexed sibling answers from the seeded index on the first call', async () => {
    await indexDir(main);
    const wt = path.join(workspace, 'wt-fresh');
    addWorktree(main, wt, 'fresh');

    const started = Date.now();
    const res = await search(wt, 'alphaSymbol');
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(NOT_INDEXED);
    expect(res.text).not.toContain('No results found');
    expect(res.text).toContain('alphaSymbol');
    expect(res.text).toContain('src/alpha.ts');
    // The worktree now has its own index; nothing was run by hand.
    expect(fs.existsSync(path.join(wt, '.codegraph', 'codegraph.db'))).toBe(true);
  });

  // G3. Same setup as G2 plus one edited file; ~2 s.
  it('G3: the catch-up after a seed re-indexes only the file that differs from the sibling', async () => {
    await indexDir(main);
    const wt = path.join(workspace, 'wt-edit');
    addWorktree(main, wt, 'edit');
    fs.writeFileSync(path.join(wt, 'src', 'beta.ts'), 'export function betaChanged() { return 22; }\n');

    const res = await search(wt, 'betaChanged');
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(NOT_INDEXED);
    expect(res.text).toContain('src/beta.ts');

    type FileRow = { path: string; content_hash: string; indexed_at: number; node_count: number };
    type NodeRow = { id: string; file_path: string };
    const read = (root: string) => {
      const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
      try {
        return {
          files: db.prepare('SELECT path, content_hash, indexed_at, node_count FROM files ORDER BY path').all() as FileRow[],
          nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all() as NodeRow[],
        };
      } finally {
        db.close();
      }
    };
    const source = read(main);
    const seeded = read(wt);
    expect(seeded.files.map((f) => f.path)).toEqual(source.files.map((f) => f.path));
    for (const row of seeded.files) {
      const before = source.files.find((f) => f.path === row.path)!;
      if (row.path === 'src/beta.ts') {
        expect(row.content_hash).not.toBe(before.content_hash);
        expect(row.indexed_at).toBeGreaterThan(before.indexed_at);
      } else {
        // Untouched: the row the seed copied, not a re-index of the same content.
        expect(row).toEqual(before);
      }
    }
    const unchanged = (rows: NodeRow[]) => rows.filter((n) => n.file_path !== 'src/beta.ts');
    expect(unchanged(seeded.nodes)).toEqual(unchanged(source.nodes));
  });

  // G7. The opt-in half waits for a detached cold build of three files (node
  // start + index, a few seconds on a loaded machine), polling every 100 ms.
  it('G7: no indexed sibling keeps the not-indexed guidance; CODEGRAPH_AUTO_INDEX=1 builds, answering "building" meanwhile', async () => {
    const plainWt = path.join(workspace, 'wt-plain');
    addWorktree(main, plainWt, 'plain');
    const without = await search(plainWt, 'alphaSymbol');
    expect(without.isError).toBe(false);
    expect(without.text).toContain(NOT_INDEXED);
    expect(fs.existsSync(path.join(plainWt, '.codegraph'))).toBe(false);

    process.env.CODEGRAPH_AUTO_INDEX = '1';
    const wt = path.join(workspace, 'wt-cold');
    addWorktree(main, wt, 'cold');
    const note = buildingNote(real(wt));
    const first = await search(wt, 'alphaSymbol');
    expect(first.isError).toBe(false);
    expect(first.text).toContain(note);

    // Until the build is done every answer is the building note; after it,
    // a full answer. Never the not-indexed text, never an empty result from
    // a half-built index.
    let answered = false;
    const deadline = Date.now() + 45_000;
    while (!answered && Date.now() < deadline) {
      const res = await search(wt, 'alphaSymbol');
      expect(res.isError).toBe(false);
      expect(res.text).not.toContain(NOT_INDEXED);
      expect(res.text).not.toContain('No results found');
      if (res.text.includes(note)) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      expect(res.text).toContain('src/alpha.ts');
      answered = true;
    }
    expect(answered).toBe(true);
    // The builder held rebuild.pid for the whole build; it is gone once done.
    expect(await waitUntil(() => !fs.existsSync(path.join(wt, '.codegraph', 'rebuild.pid')), 10_000)).toBe(true);
    const cg = CodeGraph.openSync(wt);
    try {
      expect(cg.getIndexState()).toBe('complete');
    } finally {
      cg.close();
    }
  });

  // G7 (R6, second trigger): a repository the registry already holds counts
  // as the user's opt-in for a cold build of its other worktrees.
  it('G7: a registered repository with no indexed sibling builds the new worktree', async () => {
    registerProject(real(main), { commonDir: real(path.join(main, '.git')) });
    const wt = path.join(workspace, 'wt-registered');
    addWorktree(main, wt, 'registered');
    const first = await search(wt, 'alphaSymbol');
    expect(first.isError).toBe(false);
    expect(first.text).toContain(buildingNote(real(wt)));
    // Let the detached build finish before the workspace is removed.
    expect(await waitUntil(() => {
      const db = path.join(wt, '.codegraph', 'codegraph.db');
      return fs.existsSync(db) && !fs.existsSync(path.join(wt, '.codegraph', 'rebuild.pid'));
    }, 45_000)).toBe(true);
  });

  // G8. Indexes the sibling once; ~2 s.
  it('G8: CODEGRAPH_NO_AUTO_SEED=1 keeps the old not-indexed answer and creates no index', async () => {
    await indexDir(main);
    process.env.CODEGRAPH_NO_AUTO_SEED = '1';
    process.env.CODEGRAPH_AUTO_INDEX = '1'; // the kill switch also wins over the cold-build opt-in
    const wt = path.join(workspace, 'wt-off');
    addWorktree(main, wt, 'off');

    const res = await search(wt, 'alphaSymbol');
    expect(res.isError).toBe(false);
    expect(res.text).toContain(NOT_INDEXED);
    expect(res.text).not.toContain(buildingNote(real(wt)));
    // Nothing is started in the background either.
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(path.join(wt, '.codegraph'))).toBe(false);
    expect(listRegisteredProjects().map((p) => p.root)).not.toContain(real(wt));
  });
});

// Long enough to fail validation after the project gate, so a call opens and
// gates its project without running a query (as in mcp-idle-release-order).
const OVERSIZED_PATH = 'x'.repeat(100_000);

describe('pinned projects and the handler cache (G10, pinned half)', () => {
  let workspace: string;
  let saved: Record<string, string | undefined>;
  let handler: ToolHandler;
  let released: string[];

  beforeEach(() => {
    saved = snapshotEnv();
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-seed-pin-')));
    released = [];
    const lifecycle: ProjectLifecycle = {
      open: (root) => ({
        getProjectRoot: () => root,
        reopenIfReplaced: () => false,
        close: () => {},
      }) as unknown as CodeGraph,
      activate: () => Promise.resolve(),
      release: (cg) => { released.push(path.basename(cg.getProjectRoot())); },
    };
    handler = new ToolHandler(null);
    handler.setProjectLifecycle(lifecycle);
  });

  afterEach(async () => {
    await handler.closeAll();
    restoreEnv(saved);
    clearRegistry();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Real (empty) indexes, so the roots resolve; the lifecycle never opens them. */
  function project(name: string): string {
    const dir = path.join(workspace, name);
    CodeGraph.initSync(dir).close();
    return dir;
  }

  async function touch(dir: string): Promise<void> {
    const res = await handler.execute('codegraph_files', { projectPath: dir, path: OVERSIZED_PATH });
    expect(res.content[0]!.text).toContain('path exceeds maximum length');
  }

  // Waits out the handler's idle timer, whose floor is 1 s.
  it('G10: a pinned root survives idle release; an unpinned peer is released', async () => {
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '1000';
    const pinned = project('pinned');
    const peer = project('peer');
    pinProject(real(pinned));

    await touch(pinned);
    await touch(peer);
    expect(await waitUntil(() => released.includes('peer'), 4000)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(released).toEqual(['peer']);
  });

  it('G10: a pinned root survives LRU eviction and does not count toward MAX_CACHED_PROJECTS', async () => {
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '0'; // only the LRU bound releases
    const pinned = project('pinned');
    pinProject(real(pinned));
    await touch(pinned); // least recently used from here on

    for (let i = 0; i < MAX_CACHED_PROJECTS; i++) await touch(project(`u${i}`));
    // The pinned root plus MAX_CACHED_PROJECTS unpinned ones: within the bound.
    expect(released).toEqual([]);

    await touch(project(`u${MAX_CACHED_PROJECTS}`));
    // One over: the oldest UNPINNED root goes, the pinned one stays.
    expect(released).toEqual(['u0']);
  });
});
