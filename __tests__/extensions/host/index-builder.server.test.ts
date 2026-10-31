/**
 * The server side of the index builder: what the engine, the tool handler and the query workers do and do
 * not do, given that every index write belongs to the builder.
 *
 *  - N4: a path with no index, asked through an engine that has a builder, is never told "isn't indexed
 *    ... don't call codegraph for it again" (no answer says that). In a git worktree it gets the building
 *    note when the builder is building one, and the not-yet-seeded guidance when it is not. A directory
 *    outside git is put to the builder too, with the session's anchor root, and gets the building note;
 *    one the builder will not build (home) or failed to build gets a text that names the reason. The
 *    plain not-indexed text answers an engine with no builder (the fallback).
 *  - A query worker's handler opens every project read-only: an index with an unfinished repair is not
 *    healed by a worker (a writable open rewrites the database; a read-only one leaves it).
 *  - The builder is asked to hold an index before the handler opens it, once per open: not on every call.
 *  - Freshness (the staleness banner, `codegraph_status`) is read from the builder's pushed state, not
 *    from the server's own handles, which never watch.
 *
 * The builder here is a stub that records what it is asked: its real behavior has its own tests and the
 * gates (index-builder.gate.test.ts). The exception is the symlink-into-a-nested-repository case, which runs a
 * real BuilderService and a real cold build. Real git worktrees and real SQLite in a temp dir.
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
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { buildingNote } from '../../../src/extensions/host/worktree-lifecycle/seed';
import { resolveRepoAnchor } from '../../../src/extensions/host/server/repo-anchor';
import { dispatchToolCall } from '../../../src/extensions/host/server/tool-call';
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
    // A call that carries a session anchor is recorded with it: `ensure <path> anchor <root>`.
    ensure: async (projectPath: string, anchorRoot?: string) => {
      calls.push(anchorRoot === undefined ? `ensure ${projectPath}` : `ensure ${projectPath} anchor ${anchorRoot}`);
      return outcome(projectPath);
    },
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

  it('N4: a directory outside git with no index is put to the builder, with the session anchor when the call has one, and answers the building note', async () => {
    const plain = path.join(workspace, 'plain');
    const sub = path.join(plain, 'src');
    fs.mkdirSync(sub, { recursive: true });
    // The stub names the build root it was given: the anchor when there is one, else the path.
    let anchored: string | undefined;
    const { builder, calls } = stubBuilder(() => ({ kind: 'building', root: anchored ?? sub }));
    engine = new MCPEngine({ builder });
    const handler = engine.getToolHandler();

    // A session: the call on a subdirectory reaches the builder with the anchor root beside it.
    anchored = plain;
    const withAnchor = await handler.execute('codegraph_explore', { query: 'x', projectPath: sub }, undefined, { ...ADMIT_ALL, anchorRoot: plain });
    expect(withAnchor.isError).toBeFalsy();
    expect(textOf(withAnchor)).toContain(buildingNote(plain));
    expect(textOf(withAnchor)).not.toContain(DONT_CALL_AGAIN);
    // No session (a direct caller): the path is the build root, and no anchor is sent.
    anchored = undefined;
    const withoutAnchor = await handler.execute('codegraph_explore', { query: 'x', projectPath: sub }, undefined, ADMIT_ALL);
    expect(textOf(withoutAnchor)).toContain(buildingNote(sub));
    expect(calls).toEqual([`ensure ${sub} anchor ${plain}`, `ensure ${sub}`]);
  });

  it('N4: a plain directory the builder will not build (home) or failed to build answers its own success-shaped text: the reason, the built-in tools, a project inside it, never "don\'t call again" or the worktree text', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    let outcome: EnsureOutcome = { kind: 'none', unbuilt: { root: plain, unsafe: 'your home directory' } };
    const { builder } = stubBuilder(() => outcome);
    engine = new MCPEngine({ builder });
    const handler = engine.getToolHandler();

    const unsafe = textOf(await handler.execute('codegraph_explore', { query: 'x', projectPath: plain }, undefined, ADMIT_ALL));
    expect(unsafe).toContain(NOT_INDEXED);
    expect(unsafe).toContain('(your home directory)');
    expect(unsafe).toContain('built-in tools');
    expect(unsafe).toContain('a git repository');
    expect(unsafe).not.toContain(DONT_CALL_AGAIN);
    expect(unsafe).not.toContain('is a git worktree');
    expect(unsafe).not.toContain("don't call");

    outcome = { kind: 'none', unbuilt: { root: plain } };
    const failed = textOf(await handler.execute('codegraph_explore', { query: 'x', projectPath: plain }, undefined, ADMIT_ALL));
    expect(failed).toContain(NOT_INDEXED);
    expect(failed).toContain('failed');
    expect(failed).toContain('until the CodeGraph server restarts');
    expect(failed).toContain('built-in tools');
    expect(failed).not.toContain("don't call");
    expect(failed).not.toContain('is a git worktree');

    // A builder that gave no answer for it (down, kill switch) is the plain not-indexed text (no "don't call again").
    outcome = { kind: 'none' };
    const plainText = textOf(await handler.execute('codegraph_explore', { query: 'x', projectPath: plain }, undefined, ADMIT_ALL));
    expect(plainText).toContain(NOT_INDEXED);
    expect(plainText).toContain('codegraph init');
    expect(plainText).not.toContain("don't call");
  });

  it('control: an engine with no builder (the fallback) answers a git worktree with no index the plain not-indexed text', async () => {
    const { wt } = unindexedWorktree();
    engine = new MCPEngine();

    const res = await engine.getToolHandler().execute('codegraph_explore', { query: 'alphaSymbol', projectPath: wt }, undefined, ADMIT_ALL);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(NOT_INDEXED);
    expect(textOf(res), 'the fallback text does not tell the agent to stop calling codegraph').not.toContain("don't call");
    expect(fs.existsSync(path.join(wt, '.codegraph')), 'nothing was built or copied').toBe(false);
  });

  /**
   * An indexed checkout whose `nested/` is gitignored by it, and a separate git repository inside it (with one
   * commit and `src/`). Returns the realpaths.
   */
  async function indexedOuterWithNested(): Promise<{ outer: string; nested: string; src: string }> {
    const outer = path.join(workspace, 'outer');
    const nested = path.join(outer, 'nested');
    const src = path.join(nested, 'src');
    fs.mkdirSync(path.join(outer, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outer, '.gitignore'), 'nested/\n');
    fs.writeFileSync(path.join(outer, 'src', 'a.ts'), 'export function outerSymbol() { return "outer-body-marker"; }\n');
    git(outer, 'init', '-q', '-b', 'main');
    git(outer, 'config', 'user.email', 'test@example.com');
    git(outer, 'config', 'user.name', 'Test');
    git(outer, 'config', 'commit.gpgsign', 'false');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'init');
    const cg = await CodeGraph.init(outer);
    try { await cg.indexAll(); } finally { cg.close(); }

    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export function nestedSymbol() { return "nested-body-marker"; }\n');
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'config', 'user.email', 'test@example.com');
    git(nested, 'config', 'user.name', 'Test');
    git(nested, 'config', 'commit.gpgsign', 'false');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'init');
    return { outer: fs.realpathSync(outer), nested: fs.realpathSync(nested), src: fs.realpathSync(src) };
  }

  it('a session launched in a nested repository is asked about its own path: the builder answers for it, and the outer index is not refused for it', async () => {
    const { nested, src } = await indexedOuterWithNested();
    const { builder, calls } = stubBuilder(() => ({ kind: 'building', root: nested }));
    engine = new MCPEngine({ builder });
    // The server's own path for a call: the session's call guard, its index admission and its anchor root.
    const anchor = await resolveRepoAnchor(nested);
    const outcome = await dispatchToolCall({
      handler: engine.getToolHandler(),
      anchor,
      params: { name: 'codegraph_explore', arguments: { query: 'nestedSymbol', projectPath: src } },
    });
    if (!('result' in outcome)) throw new Error(`the call was turned down as a protocol error: ${JSON.stringify(outcome.error)}`);

    const res = outcome.result;
    expect(res.isError, 'success-shaped').toBeFalsy();
    expect(textOf(res), 'not the refusal for the outer index').not.toContain('answers only for the repository');
    expect(textOf(res)).toContain(buildingNote(nested));
    expect(textOf(res)).not.toContain(DONT_CALL_AGAIN);
    expect(calls, 'the builder is asked about the nested path, with the session anchor').toContain(`ensure ${src} anchor ${nested}`);
  });

  it('an engine with no builder answers a plain directory, and a nested repository under an indexed parent, with the not-indexed text that names codegraph init, never the user\'s decision', async () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    const { src } = await indexedOuterWithNested();
    engine = new MCPEngine();
    const handler = engine.getToolHandler();

    for (const projectPath of [plain, src]) {
      const text = textOf(await handler.execute('codegraph_explore', { query: 'x', projectPath }, undefined, ADMIT_ALL));
      expect(text, projectPath).toContain(NOT_INDEXED);
      expect(text, projectPath).toContain('codegraph init');
      expect(text, projectPath).toContain('built-in tools');
      expect(text, projectPath).not.toContain("user's decision");
    }
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

  // ---- a symlink into a nested repository ----

  // The builder decides on the real path: for projectPath=/work/link (-> /work/nested-repo/src, under a
  // session anchored at the non-git /work) it builds /work/nested-repo. The answer path must select by the
  // same real path, or the alias gets the not-indexed text while the real spelling answers. Real
  // BuilderService, real cold build, real handler; only the IPC between them is a function call.
  it.runIf(process.platform !== 'win32')('a symlink into a nested repository is answered from the index the builder built for it, as the real spelling is', async () => {
    const work = path.join(workspace, 'work');
    const nested = path.join(work, 'nested-repo');
    const src = path.join(nested, 'src');
    fs.mkdirSync(src, { recursive: true });
    git(nested, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const link = path.join(work, 'link');
    fs.symlinkSync(src, link);
    const savedState = process.env.CODEGRAPH_STATE_DIR;
    process.env.CODEGRAPH_STATE_DIR = path.join(workspace, 'state');
    const jobLines: string[] = [];
    const service = new BuilderService({
      send: () => { /* the pushed freshness is not under test */ },
      jobLog: (line) => { jobLines.push(line); },
      log: () => { /* diagnostics are not under test */ },
      watchOptions: () => ({ debounceMs: 100 }),
      timing: { pollMs: 25, ownRetryMs: 50, recoverWaitMs: 1_000, seedWaitMs: 1_000 },
      housekeeping: false,
    });
    try {
      const builder = {
        ensure: (projectPath: string, anchorRoot?: string) => service.ensure(projectPath, anchorRoot),
        caughtUp: (root: string) => service.holders.caughtUp(root),
        sync: (root: string) => service.holders.sync(root),
        release: (root: string) => service.holders.release(root),
        freshness: (root: string) => service.freshness(root),
      } as unknown as BuilderClient;
      engine = new MCPEngine({ builder });
      const handler = engine.getToolHandler();
      const session = { ...ADMIT_ALL, anchorRoot: work };

      // First call through the alias: the builder queues the build at the nested repository, never at /work.
      const first = await handler.execute('codegraph_explore', { query: 'alphaSymbol', projectPath: link }, undefined, session);
      expect(first.isError).toBeFalsy();
      expect(textOf(first)).toContain(buildingNote(fs.realpathSync(nested)));
      const built = async (): Promise<boolean> => {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          if (jobLines.some((l) => / job end cold-build \S+ (ok|fail\S*)$/.test(l))) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };
      expect(await built(), `the cold build ended (${jobLines.join(' | ')})`).toBe(true);
      expect(jobLines.some((l) => / job end cold-build \S+ ok$/.test(l)), jobLines.join(' | ')).toBe(true);
      expect(fs.existsSync(path.join(nested, '.codegraph')), 'built at the nested repository').toBe(true);
      expect(fs.existsSync(path.join(work, '.codegraph')), 'nothing built at the anchor').toBe(false);

      // Now the index exists: the alias is answered from it, the same as the real spelling.
      const viaLink = await handler.execute('codegraph_explore', { query: 'alphaSymbol', projectPath: link }, undefined, session);
      const viaReal = await handler.execute('codegraph_explore', { query: 'alphaSymbol', projectPath: src }, undefined, session);
      expect(viaReal.isError).toBeFalsy();
      expect(textOf(viaReal)).toContain('alphaSymbol');
      expect(viaLink.isError).toBeFalsy();
      expect(textOf(viaLink)).not.toContain(NOT_INDEXED);
      expect(textOf(viaLink)).not.toContain(buildingNote(fs.realpathSync(nested)));
      expect(textOf(viaLink)).toContain('alphaSymbol');
    } finally {
      await service.stop(0);
      if (savedState === undefined) delete process.env.CODEGRAPH_STATE_DIR;
      else process.env.CODEGRAPH_STATE_DIR = savedState;
    }
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
