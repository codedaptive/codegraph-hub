import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { listRegisteredProjects } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { resolveRepoAnchor } from '../../../src/extensions/host/server/repo-anchor';
import { dispatchToolCall } from '../../../src/extensions/host/server/tool-call';

describe('MCP calls require a git worktree', { timeout: 60_000 }, () => {
  let tmp: string;
  let savedState: string | undefined;
  let engine: MCPEngine;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-only-mcp-')));
    savedState = process.env.CODEGRAPH_STATE_DIR;
    process.env.CODEGRAPH_STATE_DIR = path.join(tmp, 'state');
    __setLoadCodeGraphForTests(CodeGraph);
    engine = new MCPEngine();
  });

  afterEach(async () => {
    await engine.stop();
    __setLoadCodeGraphForTests(null);
    if (savedState === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = savedState;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function search(anchorDir: string, projectPath: string) {
    const outcome = await dispatchToolCall({
      handler: engine.getToolHandler(),
      anchor: await resolveRepoAnchor(anchorDir),
      params: { name: 'codegraph_search', arguments: { query: 'alphaSymbol', projectPath } },
    });
    if (!('result' in outcome)) throw new Error(JSON.stringify(outcome.error));
    return outcome.result;
  }

  it('answers a subfolder query from its indexed git worktree', async () => {
    const repo = path.join(tmp, 'repo');
    const src = path.join(repo, 'src');
    fs.mkdirSync(src, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(repo);
    try { await cg.indexAll(); } finally { cg.close(); }
    const result = await search(repo, src);
    expect(result.isError).toBeUndefined();
    expect(result.content.map((c) => c.text).join('\n')).toContain('alphaSymbol');
  });

  it('refuses a plain folder without creating an index or registering anything', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const requests: string[] = [];
    const builder = {
      ensure: async (root: string) => { requests.push(root); return { kind: 'none' }; },
      caughtUp: async () => undefined,
      sync: async () => ({ filesChanged: 0 }),
      release: async () => undefined,
      freshness: () => null,
    } as unknown as BuilderClient;
    engine = new MCPEngine({ builder });
    const result = await search(tmp, plain);
    expect(fs.existsSync(path.join(plain, '.codegraph'))).toBe(false);
    expect(listRegisteredProjects()).toEqual([]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain(`${plain} is not in a git repository`);
    expect(requests).toEqual([]);
  });

  it('refuses a plain folder even when it already has a searchable index', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(plain);
    try { await cg.indexAll(); } finally { cg.close(); }
    expect(fs.existsSync(path.join(plain, '.codegraph'))).toBe(true);
    const result = await search(tmp, plain);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`${plain} is not in a git repository`);
    expect(result.content.map((c) => c.text).join('\n')).not.toContain('alphaSymbol');
  });
});
