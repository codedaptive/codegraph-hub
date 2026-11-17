import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CodeGraph from '../../../src/index';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { selectOwnIndexRoot } from '../../../src/extensions/host/server/index-root';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';

let workspace: string;
let engine: MCPEngine | undefined;
let savedStateDir: string | undefined;
beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ended-guidance-')));
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = workspace;
  __setLoadCodeGraphForTests(CodeGraph);
});
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  __setLoadCodeGraphForTests(null);
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function builderFor(root: string): BuilderClient {
  return {
    ensure: async () => ({ kind: 'none', ended: { root, kind: 'cold-build', limit: 'time' } }),
    caughtUp: async () => undefined,
    sync: async () => ({ filesChanged: 0 }),
    release: async () => undefined,
    freshness: () => null,
  } as unknown as BuilderClient;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((item) => item.text ?? '').join('\n');

describe('ended builder guidance at the tool handler', () => {
  it('answers with success-shaped guidance when there is no selectable index', async () => {
    const root = path.join(workspace, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    // A nested repository prevents an indexed TMPDIR ancestor from answering this call.
    expect(selectOwnIndexRoot(root)).toBeNull();
    new EndedJobsFile(path.join(workspace, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'cold-build', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(textOf(result)).toContain('codegraph index');
    expect(textOf(result)).toContain(root);
    expect(textOf(result)).toContain('Use your built-in tools');
    expect(textOf(result)).not.toContain('partial or behind');
  });

  it('serves an existing index instead of reporting the ended job', async () => {
    const root = path.join(workspace, 'indexed');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    // A git repository: a builder engine serves only an index inside a git worktree (R-46).
    execFileSync('git', ['init', '-q', root]);
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    expect(selectOwnIndexRoot(root)).toBe(root);
    new EndedJobsFile(path.join(workspace, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'cold-build', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('alphaSymbol');
    expect(textOf(result)).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(textOf(result)).toContain('partial or behind');
    expect(textOf(result)).toContain('codegraph index');
  });
});
