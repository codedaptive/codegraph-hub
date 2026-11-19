/**
 * Ownership and lifetime validation. The case drives the shipped entry point
 * with the built index builder (`BuilderClient.start` runs it from dist/) and
 * asserts which handles are still held, not names or return values.
 *
 * O3 engine release (`MCPEngine.releaseProjectRoot`, with an index builder): a
 *    call that reopens a root while its release waits for in-flight calls
 *    holds it again; once the root is released again the builder's writer
 *    slot is freed and the engine's database handle is closed.
 *
 * A real git repository and real SQLite in a mkdtemp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests, type ToolHandler, type ToolResult } from '../../../src/mcp/tools';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { ADMIT_ALL } from '../../helpers/admit-all';
import { BuilderClient } from '../../../src/extensions/host/builder/client';
import { dbFile } from './helpers/db-file';
import { Gate } from './helpers/gate';
import { indexDir } from './helpers/index-dir';
import { makeRepo } from './helpers/make-repo';
import { real } from './helpers/real';

const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v']).error === undefined;

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

// ---------------------------------------------------------------------------
// O3: engine release of a reopened root
// ---------------------------------------------------------------------------

describe('O3: a root reopened during its release is held until it is released again', { timeout: 600_000, hookTimeout: 180_000 }, () => {
  let workspace: string;
  let root: string;
  let engine: MCPEngine | undefined;
  let builder: BuilderClient | undefined;

  beforeEach(async () => {
    vi.stubEnv('CODEGRAPH_NO_AUTO_SEED', '1');
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
    vi.stubEnv('CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS', '0');
    workspace = real(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-lease-')));
    // The builder's own state dir: its pid and job files stay out of the sandbox home.
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    root = path.join(workspace, 'repo');
    makeRepo(root);
    await indexDir(root);
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    await builder?.stop();
    builder = undefined;
    __setLoadCodeGraphForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);

  async function search(handler: ToolHandler): Promise<ToolResult> {
    return handler.execute('codegraph_search', { projectPath: root, query: 'appSymbol' }, undefined, ADMIT_ALL);
  }

  // slow: a real builder must acquire the root before the test races reopening against release.
  it('the builder frees the writer slot and the engine closes its database on the second release', async () => {
    builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
    const handler = engine.getToolHandler();
    const first = await search(handler);
    expect(first.isError).toBeFalsy();
    // The writer is the builder, never this (server) process.
    await vi.waitFor(() => expect(readWriterLock(root)?.pid).toBe(builder!.pid()), { timeout: 180_000 });
    expect(builder.pid()).not.toBe(process.pid);

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
    // The call that reopened it still holds it in the engine.
    expect(cachedRoots(handler)).toContain(root);
    vi.mocked(seedHook.seedWorktreeIndex).mockRestore();

    await engine.releaseProjectRoot(root);
    expect(cachedRoots(handler)).not.toContain(root);
    // The release resolves after the builder let go: no writer holds the slot.
    expect(readWriterLock(root)).toBeNull();
    if (HAS_LSOF) expect(openFdCount([dbFile(root), `${dbFile(root)}-wal`])).toBe(0);

    // A later call opens a live graph, not the one the release closed.
    const again = await search(handler);
    expect(again.isError).toBeFalsy();
    expect(again.content[0].text).toContain('appSymbol');
  });
});
