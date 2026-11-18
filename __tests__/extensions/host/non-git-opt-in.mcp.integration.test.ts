import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { resolveRepoAnchor } from '../../../src/extensions/host/server/repo-anchor';
import { dispatchToolCall } from '../../../src/extensions/host/server/tool-call';

describe('MCP non-git opt-in', { timeout: 60_000 }, () => {
  let workspace: string;
  let engine: MCPEngine;
  beforeEach(() => {
    // '/tmp' keeps the workspace outside any git worktree whatever TMPDIR points at; Windows has no '/tmp'.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'cg-opted-mcp-')));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    __setLoadCodeGraphForTests(CodeGraph);
    engine = new MCPEngine();
  });
  afterEach(async () => {
    await engine.stop();
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  async function search(projectPath: string) {
    const outcome = await dispatchToolCall({ handler: engine.getToolHandler(), anchor: await resolveRepoAnchor(workspace), params: { name: 'codegraph_search', arguments: { query: 'alphaSymbol', projectPath } } });
    if (!('result' in outcome)) throw new Error(JSON.stringify(outcome.error));
    return outcome.result;
  }
  it.each([false, true])('serves an opted-in indexed folder with builder=%s', async (withBuilder) => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    const optIn = { noGit: true, seeded: false };
    registerProject(root, optIn);
    if (withBuilder) {
      const builder = { ensure: async () => ({ kind: 'none' }), caughtUp: async () => undefined, sync: async () => ({ filesChanged: 0 }), release: async () => undefined, freshness: () => null } as unknown as BuilderClient;
      engine = new MCPEngine({ builder });
    }
    const result = await search(root);
    expect(result.isError).toBeUndefined();
    expect(result.content.map((c) => c.text).join('\n')).toContain('alphaSymbol');
  });
  it('gives success-shaped opt-in guidance for a non-opted-in sibling', async () => {
    const root = path.join(workspace, 'sibling');
    fs.mkdirSync(root);
    const result = await search(root);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`${root} is not in a git repository`);
    expect(result.content[0].text).toContain('codegraph init');
    expect(result.content[0].text).toContain('--no-git');
  });
});
