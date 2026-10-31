/**
 * The server side of the index builder: what the engine, the tool handler and the query workers do and do
 * not do, given that every index write belongs to the builder.
 *
 *  - N4: a path in a git worktree that has no index, asked through an engine that has a builder, is
 *    never told "isn't indexed ... don't call codegraph for it again". It gets the building note when
 *    the builder is building one, and the not-yet-seeded guidance when it is not. A directory outside
 *    git keeps the plain not-indexed text, and so does an engine with no builder (the fallback).
 *  - A query worker's handler opens every project read-only: an index with an unfinished repair is not
 *    healed by a worker (a writable open rewrites the database; a read-only one leaves it).
 *  - The builder is asked to hold an index before the handler opens it, once per open: not on every call.
 *  - Freshness (the staleness banner, `codegraph_status`) is read from the builder's pushed state, not
 *    from the server's own handles, which never watch.
 *
 * The builder here is a stub that records what it is asked: its real behavior has its own tests and the
 * gates (index-builder.gate.test.ts). Real git worktrees and real SQLite in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import CodeGraph from '../../../src/index';
import type { BuilderClient, BuilderFreshness, EnsureOutcome } from '../../../src/extensions/host/builder/client';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { buildingNote } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { ADMIT_ALL } from '../../helpers/admit-all';

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const DONT_CALL_AGAIN = "don't call codegraph for it again";
const NOT_INDEXED = "isn't indexed with codegraph";

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');

/** A builder that answers `ensure` with `outcome(path)`, pushes `fresh` as freshness, and records every request. */
function stubBuilder(outcome: (projectPath: string) => EnsureOutcome, fresh: () => BuilderFreshness | null = () => null) {
  const calls: string[] = [];
  const builder = {
    ensure: async (projectPath: string) => { calls.push(`ensure ${projectPath}`); return outcome(projectPath); },
    caughtUp: async () => undefined,
    sync: async (root: string) => { calls.push(`sync ${root}`); return { filesChanged: 0 }; },
    release: async (root: string) => { calls.push(`release ${root}`); },
    freshness: () => fresh(),
  };
  return { calls, builder: builder as unknown as BuilderClient };
}

describe('the server side of the index builder', { timeout: 60_000 }, () => {
  let workspace: string;
  let engine: MCPEngine | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['CODEGRAPH_NO_AUTO_SEED', 'CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS']) saved[k] = process.env[k];
    delete process.env.CODEGRAPH_NO_AUTO_SEED;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ibserver-')));
    // Under vitest the handler's lazy require of the CodeGraph chain cannot load sources.
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    __setLoadCodeGraphForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** A git repository with one commit and no index anywhere, and a linked worktree of it. */
  function unindexedWorktree(): { main: string; wt: string } {
    const main = path.join(workspace, 'main');
    const wt = path.join(workspace, 'wt');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'config', 'user.email', 'test@example.com');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(main, 'src', 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
    return { main, wt };
  }

  // ---- N4 ----

  it('N4: a git worktree with no index, with a builder building one, answers the building note (success-shaped), never the do-not-call text', async () => {
    const { wt } = unindexedWorktree();
    const { builder, calls } = stubBuilder((p) => ({ kind: 'building', root: p }));
    engine = new MCPEngine({ builder });

    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: wt }, undefined, ADMIT_ALL);

    expect(res.isError, 'success-shaped, so the agent keeps trusting the tools').toBeFalsy();
    expect(textOf(res)).toContain(buildingNote(wt));
    expect(textOf(res)).not.toContain(DONT_CALL_AGAIN);
    expect(calls).toEqual([`ensure ${wt}`]);
  });

  it('N4: a git worktree the builder could not give an index (none, no worktree named) still gets the not-yet-seeded guidance, not the do-not-call text', async () => {
    const { wt } = unindexedWorktree();
    const { builder } = stubBuilder(() => ({ kind: 'none' }));
    engine = new MCPEngine({ builder });

    // A path inside the worktree, not its root: the guidance names the worktree it is in.
    const inside = path.join(wt, 'src');
    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: inside }, undefined, ADMIT_ALL);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('isn\'t indexed with codegraph yet');
    expect(textOf(res)).toContain(`git worktree (${wt})`);
    expect(textOf(res)).not.toContain(DONT_CALL_AGAIN);
  });

  it('N4: a directory outside git keeps the plain not-indexed text, and the builder is not even asked about it', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    const { builder, calls } = stubBuilder(() => ({ kind: 'none' }));
    engine = new MCPEngine({ builder });

    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'x', projectPath: plain }, undefined, ADMIT_ALL);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(NOT_INDEXED);
    expect(textOf(res)).toContain(DONT_CALL_AGAIN);
    expect(calls).toEqual([]);
  });

  it('control: an engine with no builder (the fallback) answers a git worktree with no index the plain not-indexed text', async () => {
    const { wt } = unindexedWorktree();
    engine = new MCPEngine();

    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: wt }, undefined, ADMIT_ALL);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(NOT_INDEXED);
    expect(fs.existsSync(path.join(wt, '.codegraph')), 'nothing was built or copied').toBe(false);
  });

  // ---- the hold, once per open ----

  async function indexedProject(): Promise<string> {
    const root = path.join(workspace, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return "alpha-body-marker"; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    return root;
  }

  it('asks the builder to hold an index before opening it, and asks again only after the root was released or the builder stopped reporting it', async () => {
    const root = await indexedProject();
    let held = false;
    const { builder, calls } = stubBuilder(
      (p) => { held = true; return { kind: 'ready', root: p }; },
      () => (held ? { root, watching: true, degradedReason: null, recovering: false, pendingFiles: [] } : null),
    );
    engine = new MCPEngine({ builder });
    const handler = engine.getToolHandler();
    const call = () => handler.execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);

    expect(textOf(await call())).toContain('alphaSymbol');
    await call();
    expect(calls.filter((c) => c.startsWith('ensure'))).toEqual([`ensure ${root}`]);

    held = false; // the builder lost its hold (it restarted before re-holding it)
    await call();
    expect(calls.filter((c) => c.startsWith('ensure'))).toHaveLength(2);

    await engine.releaseProjectRoot(root);
    expect(calls).toContain(`release ${root}`);
    held = false;
    await call();
    expect(calls.filter((c) => c.startsWith('ensure'))).toHaveLength(3);
  });

  // ---- freshness from the builder ----

  it('reads the staleness banner and the status sections from the builder\'s pushed freshness, not from its own read-only handle', async () => {
    const root = await indexedProject();
    const state: { value: BuilderFreshness } = {
      value: { root, watching: true, degradedReason: null, recovering: false, pendingFiles: ['src/a.ts'] },
    };
    const { builder } = stubBuilder((p) => ({ kind: 'ready', root: p }), () => state.value);
    engine = new MCPEngine({ builder });
    const handler = engine.getToolHandler();

    // A response that names src/a.ts gets the per-file banner; the status call lists it as pending.
    const search = await handler.execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(search)).toContain('edited since the last index sync');
    expect(textOf(search)).toContain('src/a.ts');
    const status = await handler.execute('codegraph_status', { projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(status)).toContain('**Pending sync:**');
    expect(textOf(status)).toContain('src/a.ts');

    // The builder reports the watcher degraded: the whole-index banner, and the status section with its reason.
    state.value = { root, watching: false, degradedReason: 'watch limit reached', recovering: false, pendingFiles: [] };
    const degraded = await handler.execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(degraded)).toContain('auto-sync is DISABLED');
    const degradedStatus = await handler.execute('codegraph_status', { projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(degradedStatus)).toContain('**Auto-sync disabled:**');
    expect(textOf(degradedStatus)).toContain('watch limit reached');

    // Re-armed, catch-up not finished.
    state.value = { root, watching: true, degradedReason: null, recovering: true, pendingFiles: [] };
    const recovering = await handler.execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(recovering)).toContain('auto-sync is RECOVERING');

    // Healthy, nothing pending: no banner at all.
    state.value = { root, watching: true, degradedReason: null, recovering: false, pendingFiles: [] };
    const fine = await handler.execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(fine)).not.toContain('⚠️');
  });

  // ---- the query worker ----

  it('a query worker opens every project read-only: an index with an unfinished repair is left as it is', async () => {
    const root = await indexedProject();
    // A bulk load the last writer never finished: the FTS trigger is missing. A WRITABLE open heals it by
    // rewriting the database; a read-only open leaves that to the writer.
    const dbFile = path.join(root, '.codegraph', 'codegraph.db');
    const db = new DatabaseSync(dbFile);
    db.exec('DROP TRIGGER IF EXISTS nodes_au');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const digest = (): string => {
      const ro = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const objects = ro.prepare('SELECT type, name FROM sqlite_master ORDER BY type, name').all();
        return createHash('sha256').update(JSON.stringify(objects)).update(fs.readFileSync(dbFile)).digest('hex');
      } finally {
        ro.close();
      }
    };
    const before = digest();

    const worker = new Worker(path.resolve(__dirname, '../../../dist/mcp/query-worker.js'), { workerData: { root: null } });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (m: { type?: string; ok?: boolean; error?: string }) => {
          if (m?.type === 'ready') m.ok ? resolve() : reject(new Error(String(m.error)));
        });
      });
      const result = await new Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (m: { type?: string; result?: never }) => { if (m?.type === 'result') resolve(m.result!); });
        worker.postMessage({ type: 'call', id: 1, toolName: 'codegraph_search', args: { query: 'alphaSymbol', projectPath: root } });
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('alphaSymbol');
      expect(digest(), 'the worker opened the index read-only: no repair, no migration, no write').toBe(before);
    } finally {
      await worker.terminate();
    }
  });
});
