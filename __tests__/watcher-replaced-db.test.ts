/**
 * Live sync follows a rebuilt index (issue #1902).
 *
 * `codegraph index` rebuilds through `CodeGraph.recreate()`, which unlinks
 * `.codegraph/codegraph.db` and creates a new file (a new inode) at the same
 * path. A long-lived instance keeps its handle on the old, unlinked inode, so
 * the cases below pin that it reopens the live file, that its watcher's and
 * tool calls' syncs write only into the live file, and that the edits absorbed
 * in between are reconciled into it.
 *
 * POSIX-only: an open file can't be unlinked on Windows, and st_ino is
 * unreliable there, so the replaced-inode hazard does not arise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { LockUnavailableError } from '../src/index';
import type { MCPEngine } from '../src/mcp/engine';
import { ADMIT_ALL } from './helpers/admit-all';

const posixOnly = it.runIf(process.platform !== 'win32');

/** Rebuild the index in a separate instance, the way `codegraph index` does. */
async function rebuild(root: string): Promise<void> {
  const cg = await CodeGraph.recreate(root);
  await cg.indexAll();
  cg.close();
}

/** Open the file at the path fresh (as a new CLI process would) and look up a name. */
async function onDiskHas(root: string, name: string): Promise<boolean> {
  const cg = await CodeGraph.open(root);
  try {
    return cg.searchNodes(name).some((r) => r.node.name === name);
  } finally {
    cg.close();
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

describe('live sync after the index is rebuilt by another process (#1902)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1902-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export function bravo() { return 2; }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  posixOnly('a watcher-picked-up edit lands in the NEW database file, not the unlinked one', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    let synced = 0;
    expect(server.watch({ debounceMs: 100, onSyncComplete: () => { synced++; } })).toBe(true);
    try {
      await rebuild(root);

      fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function beta() { return alpha(); }\n');
      await waitFor(() => synced > 0);

      // A fresh open of the path sees the edit — the watcher wrote into the live file.
      expect(await onDiskHas(root, 'beta')).toBe(true);
      // And the server itself now holds the live file.
      expect(server.searchNodes('beta').some((r) => r.node.name === 'beta')).toBe(true);
      expect(server.reopenIfReplaced()).toBe(false);
    } finally {
      server.unwatch();
      server.close();
    }
  });

  posixOnly('a sync in the gap between recreate and indexAll steps aside, then reconciles in full', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    try {
      // `codegraph index`: the file is recreated first, the write lock is taken later by indexAll.
      const rebuilder = await CodeGraph.recreate(root);
      fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function gamma() { return 3; }\n');
      // A sync of the same instance lands in the gap: it must not claim the lock for a
      // full reconcile of the empty file, and reports contention instead of success.
      await expect(server.sync({ paths: ['src/a.ts'] })).rejects.toBeInstanceOf(LockUnavailableError);
      // So the rebuild still gets its lock and completes.
      const built = await rebuilder.indexAll();
      expect(built.success).toBe(true);
      rebuilder.close();
      // An edit the rebuild did not see, made after it finished.
      fs.appendFileSync(path.join(root, 'src', 'b.ts'), 'export function delta() { return 4; }\n');
      // The next (scoped, unrelated) sync is widened to the whole tree once.
      fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export function echo() { return 5; }\n');
      const after = await server.sync({ paths: ['src/c.ts'] });
      expect(after.filesChecked).toBeGreaterThan(1);
      expect(await onDiskHas(root, 'gamma')).toBe(true);
      expect(await onDiskHas(root, 'delta')).toBe(true);
      expect(await onDiskHas(root, 'echo')).toBe(true);
      // And only once: the following scoped sync stays scoped.
      fs.appendFileSync(path.join(root, 'src', 'c.ts'), 'export function foxtrot() { return 6; }\n');
      const scoped = await server.sync({ paths: ['src/c.ts'] });
      expect(scoped.filesChecked).toBe(1);
    } finally {
      server.close();
    }
  });

  posixOnly('a watcher sync that lands in the rebuild gap keeps its pending files until the rebuild is reconciled', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    // Record every sync the watcher starts, so the test can wait for the one in the gap.
    const attempts: Array<Promise<unknown>> = [];
    const realSync = server.sync.bind(server);
    (server as any).sync = (options?: Parameters<CodeGraph['sync']>[0]) => {
      const run = realSync(options);
      attempts.push(run);
      return run;
    };
    let synced = 0;
    // The lock-contention backoff (debounce · 2^n, degrading after 5 retries)
    // must outlast the rebuild below; 200 ms leaves several seconds.
    expect(server.watch({ debounceMs: 200, onSyncComplete: () => { synced++; } })).toBe(true);
    try {
      // `codegraph index` has recreated the file but not taken the write lock yet.
      const rebuilder = await CodeGraph.recreate(root);
      fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function gamma() { return 3; }\n');
      await waitFor(() => attempts.length > 0);
      await expect(attempts[0]).rejects.toBeInstanceOf(LockUnavailableError);
      // Stepping aside is not a sync: the edit stays pending, nothing is reported as synced.
      expect(synced).toBe(0);
      expect(server.getPendingFiles().map((f) => f.path)).toContain('src/a.ts');

      const built = await rebuilder.indexAll();
      expect(built.success).toBe(true);
      rebuilder.close();

      // The watcher's retry reconciles the rebuilt file and only then clears the edit.
      await waitFor(() => synced > 0);
      expect(await onDiskHas(root, 'gamma')).toBe(true);
      expect(server.getPendingFiles()).toEqual([]);
    } finally {
      server.unwatch();
      server.close();
    }
  });

  posixOnly('a scoped sync that finds the database replaced reconciles the whole tree', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    try {
      await rebuild(root);

      // Two edits after the rebuild, but the sync is told about only one of
      // them — the other stands for everything the dead handle absorbed.
      fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function beta() { return 3; }\n');
      fs.appendFileSync(path.join(root, 'src', 'b.ts'), 'export function charlie() { return 4; }\n');
      await server.sync({ paths: ['src/a.ts'] });

      expect(await onDiskHas(root, 'beta')).toBe(true);
      expect(await onDiskHas(root, 'charlie')).toBe(true);

      // Once the handle is live again, a scoped sync stays scoped.
      fs.appendFileSync(path.join(root, 'src', 'b.ts'), 'export function delta() { return 5; }\n');
      await server.sync({ paths: ['src/a.ts'] });
      expect(await onDiskHas(root, 'delta')).toBe(false);
    } finally {
      server.close();
    }
  });

  posixOnly('reopenIfReplaced does not swap the connection under an in-flight sync', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    try {
      await rebuild(root);
      const inFlight = server.sync();
      expect(server.isIndexing()).toBe(true);
      expect(server.reopenIfReplaced()).toBe(false);
      await inFlight;
      // The sync itself followed the path.
      expect(server.reopenIfReplaced()).toBe(false);
      fs.appendFileSync(path.join(root, 'src', 'a.ts'), 'export function echo() { return 6; }\n');
      await server.sync({ paths: ['src/a.ts'] });
      expect(await onDiskHas(root, 'echo')).toBe(true);
    } finally {
      server.close();
    }
  });

  // The engine lazily `require`s the CodeGraph module, which only resolves in
  // the built output, so this block drives the built engine (as the
  // spawned-CLI suites do); `npm run build` first.
  describe('tool-call reopen through the MCP engine', () => {
    const ENGINE = path.resolve(__dirname, '../dist/mcp/engine.js');
    let prevDebounce: string | undefined;

    beforeEach(() => {
      // Keep the watcher from syncing the edit on its own, so only the
      // tool-call path's catch-up can put it in the rebuilt file.
      prevDebounce = process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
      process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '60000';
    });

    afterEach(() => {
      if (prevDebounce === undefined) delete process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
      else process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = prevDebounce;
    });

    // The builder is the engine's writer: a real process, started from the built client.
    const { BuilderClient: Builder } = require(path.resolve(__dirname, '../dist/extensions/host/builder/client.js')) as
      typeof import('../src/extensions/host/builder/client');
    let builder: InstanceType<typeof Builder> | null = null;

    afterEach(async () => {
      await builder?.stop();
      builder = null;
    });

    async function openEngine(withBuilder: boolean): Promise<MCPEngine> {
      const seed = CodeGraph.initSync(root);
      await seed.indexAll();
      seed.close();
      if (!fs.existsSync(ENGINE)) throw new Error(`${ENGINE} missing — run \`npm run build\` first`);
      const { MCPEngine: Engine } = require(ENGINE) as { MCPEngine: typeof MCPEngine };
      if (withBuilder) builder = Builder.start();
      const engine = new Engine(builder ? { builder } : {});
      // Open the project through its projectPath and drain its post-open
      // catch-up gate (this proves the project is loaded).
      const first = await engine.getToolHandler().execute('codegraph_search', { query: 'alpha', projectPath: root }, undefined, ADMIT_ALL);
      expect(first.content[0].text).toMatch(/alpha/);
      return engine;
    }

    // Own timeout. It starts a real builder process, rebuilds the index and runs a
    // catch-up sync through it. On 18 CPUs, at 1-minute load average ~80-110, it ran
    // 17-28 s (28.0 s once alone, 17-20 s with four copies). Re-measured after the change:
    // 14.4-15.6 s. The 90 s limit is about three times the slowest run measured (32.0 s).
    posixOnly('reopening a replaced database runs a catch-up sync into the new file, on the builder', async () => {
      const engine = await openEngine(true);
      try {
        await rebuild(root);
        fs.appendFileSync(path.join(root, 'src', 'b.ts'), 'export function foxtrot() { return 7; }\n');
        expect(await onDiskHas(root, 'foxtrot')).toBe(false);

        const handler = engine.getToolHandler();
        // This call reopens the replaced database and has the builder start the catch-up;
        // the next call awaits its gate.
        await handler.execute('codegraph_search', { query: 'alpha', projectPath: root }, undefined, ADMIT_ALL);
        const res = await handler.execute('codegraph_search', { query: 'foxtrot', projectPath: root }, undefined, ADMIT_ALL);
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toMatch(/foxtrot/);
        expect(await onDiskHas(root, 'foxtrot')).toBe(true);
      } finally {
        await engine.stop();
      }
    }, 90_000);

    posixOnly('an engine with no builder reopens but does not write', async () => {
      const engine = await openEngine(false);
      try {
        await rebuild(root);
        fs.appendFileSync(path.join(root, 'src', 'b.ts'), 'export function golf() { return 8; }\n');

        const handler = engine.getToolHandler();
        await handler.execute('codegraph_search', { query: 'alpha', projectPath: root }, undefined, ADMIT_ALL);
        await handler.execute('codegraph_search', { query: 'golf', projectPath: root }, undefined, ADMIT_ALL);
        expect(await onDiskHas(root, 'golf')).toBe(false);
      } finally {
        await engine.stop();
      }
    });
  });

  posixOnly('a reopen by a tool call widens the next scoped sync to the whole tree', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    try {
      await rebuild(root);
      // The self-heal on the tool-call path, not a sync, follows the path.
      expect(server.reopenIfReplaced()).toBe(true);
      const live = (server as any).orchestrator;
      const calls: Array<string[] | undefined> = [];
      const sync = live.sync.bind(live);
      live.sync = (onProgress: unknown, paths: string[] | undefined, ...rest: unknown[]) => {
        calls.push(paths);
        return sync(onProgress, paths, ...rest);
      };
      await server.sync({ paths: ['src/a.ts'] });
      await server.sync({ paths: ['src/a.ts'] });
      // The first sync after the reopen reconciled everything; the next stays scoped.
      expect(calls).toEqual([undefined, ['src/a.ts']]);
    } finally {
      server.close();
    }
  });

  posixOnly('a catch-up sync that fails keeps the full reconcile for the next one', async () => {
    const server = CodeGraph.initSync(root);
    await server.indexAll();
    try {
      await rebuild(root);
      expect(server.reopenIfReplaced()).toBe(true);
      const live = (server as any).orchestrator;
      const calls: Array<string[] | undefined> = [];
      const sync = live.sync.bind(live);
      let failNext = true;
      live.sync = (onProgress: unknown, paths: string[] | undefined, ...rest: unknown[]) => {
        calls.push(paths);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('injected sync failure'));
        }
        return sync(onProgress, paths, ...rest);
      };
      await expect(server.sync({ paths: ['src/a.ts'] })).rejects.toThrow('injected sync failure');
      await server.sync({ paths: ['src/a.ts'] });
      expect(calls).toEqual([undefined, undefined]);
    } finally {
      server.close();
    }
  });
});
