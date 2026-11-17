/**
 * Extension hook, worker path: an extension tool called through the real
 * dist query pool runs inside a worker thread with a real CodeGraph, and the
 * same call with the pool detached runs on the main thread.
 *
 * Uses the BUILT engine (as query-pool.test.ts does) so the pool loads the real
 * compiled worker sibling, and that worker loads the fixture through
 * CODEGRAPH_EXTENSION_MODULES, inherited from process.env at worker creation.
 * This file imports nothing from src/extensions/host, so it tests the built
 * engine's behaviour.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import type { MCPEngine } from '../../../src/mcp/engine';
import type { QueryPool } from '../../../src/mcp/query-pool';
import { ADMIT_ALL } from '../../helpers/admit-all';

const FIXTURE = path.resolve(__dirname, 'fixtures/test-extension.cjs');
const BuiltEngine: typeof MCPEngine = require('../../../dist/mcp/engine').MCPEngine;

describe('extension hook: query-pool worker dispatch', () => {
  let tempDir: string;
  let engine: MCPEngine | undefined;
  let pool: QueryPool | null = null;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ext-worker-')));
    vi.stubEnv('CODEGRAPH_QUERY_POOL_SIZE', '1');
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', FIXTURE);
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,ext_echo');
  });

  afterEach(async () => {
    await pool?.destroy();
    pool = null;
    await engine?.stop();
    engine = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Can run past 5 s under load (1.7 s at load ~75): it starts a real worker
  // thread, which loads the compiled engine and opens the SQLite index before
  // it reports ready (query-pool.test.ts's integration tests carry the same
  // cost).
  it('runs the extension tool in a worker, and on the main thread with the pool detached', async () => {
    const root = path.join(tempDir, 'proj');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export function hello() { return 42; }\n');
    const cg = await CodeGraph.init(root);
    let fileCount: number;
    try {
      await cg.indexAll();
      fileCount = cg.getStats().fileCount;
    } finally { cg.close(); }

    engine = new BuiltEngine({ watch: false, queryPool: true });
    pool = (engine as unknown as { queryPool: QueryPool | null }).queryPool;
    expect(pool).not.toBeNull();
    await vi.waitFor(() => expect(pool!.ready).toBe(true), { timeout: 15000 });

    const handler = engine.getToolHandler();
    const pooled = await handler.execute('codegraph_ext_echo', { text: 'hi', projectPath: root }, undefined, ADMIT_ALL);
    expect(pooled.content[0].text).toContain(`ext_echo:hi:${fileCount}`);
    expect(pooled.content[0].text).toContain('thread:worker');
    expect(pooled.isError).toBeFalsy();

    handler.setQueryPool(null);
    const direct = await handler.execute('codegraph_ext_echo', { text: 'hi', projectPath: root }, undefined, ADMIT_ALL);
    handler.setQueryPool(pool);
    expect(direct.content[0].text).toContain(`ext_echo:hi:${fileCount}`);
    expect(direct.content[0].text).toContain('thread:main');
    expect(direct.isError).toBeFalsy();
  }, 30000);
});
