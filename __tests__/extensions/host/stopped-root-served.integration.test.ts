import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CodeGraph from '../../../src/index';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { clearEndedRoot } from '../../../src/extensions/host/builder/clear-ended-root';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';

let workspace: string;
let stateDir: string;
let savedStateDir: string | undefined;
let engine: MCPEngine | undefined;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stopped-served-')));
  stateDir = path.join(workspace, 'state');
  fs.mkdirSync(stateDir);
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = stateDir;
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
    ensure: async () => ({ kind: 'ready', root }),
    caughtUp: async () => undefined,
    sync: async () => ({ filesChanged: 0 }),
    release: async () => undefined,
    freshness: () => null,
  } as unknown as BuilderClient;
}

async function indexedRepo(name: string): Promise<string> {
  const root = path.join(workspace, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
  const cg = await CodeGraph.init(root);
  try { await cg.indexAll(); } finally { cg.close(); }
  return root;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((item) => item.text ?? '').join('\n');

describe('serving a stopped root', () => {
  it.each([
    ['open', 'time', 'CODEGRAPH_BUILDER_JOB_MAX_MS'],
    ['sync', 'time', 'CODEGRAPH_BUILDER_JOB_MAX_MS'],
    ['catch-up', 'time', 'CODEGRAPH_BUILDER_JOB_MAX_MS'],
    ['sync', 'rss', 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB'],
  ] as const)('includes the %s %s note on consecutive search answers', async (kind, limit, variable) => {
    const root = await indexedRepo('repo');
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind, limit, at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    for (let call = 0; call < 2; call++) {
      const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('alphaSymbol');
      expect(textOf(result)).toContain(variable);
      expect(textOf(result)).toContain('partial or behind');
      expect(textOf(result)).toContain('codegraph index');
      const note = textOf(result).split(/\r?\n/).find(line => line.includes('partial or behind'));
      expect(note).toContain(`last ${kind} job of ${root} at its ${limit === 'time' ? 'time' : 'memory'} limit`);
      expect(note).toMatch(new RegExp(`\\b${variable}\\b`));
      expect(note).not.toMatch(limit === 'time' ? /\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/ : /\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
      expect(note).toContain(`codegraph index ${root}`);
    }
  });

  it('includes the stopped note in status', async () => {
    const root = await indexedRepo('repo');
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    const result = await engine.getToolHandler().execute('codegraph_status', { projectPath: root }, undefined, ADMIT_ALL);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(textOf(result)).toContain('partial or behind');
    expect(textOf(result)).toContain('codegraph index');
    const note = textOf(result).split(/\r?\n/).find(line => line.includes('partial or behind'));
    expect(note).toContain(`last open job of ${root} at its time limit`);
    expect(note).toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
    expect(note).not.toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/);
    expect(note).toContain(`codegraph index ${root}`);
  });

  it('stops adding the note after the root is cleared', async () => {
    const root = await indexedRepo('repo');
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    const before = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(textOf(before)).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    const note = textOf(before).split(/\r?\n/).find(line => line.includes('partial or behind'));
    expect(note).toContain(`last open job of ${root} at its time limit`);
    expect(note).toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
    expect(note).not.toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/);
    expect(note).toContain(`codegraph index ${root}`);
    clearEndedRoot(root, stateDir);
    const after = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(after.isError).toBeFalsy();
    expect(textOf(after)).toContain('alphaSymbol');
    expect(textOf(after)).not.toContain('CODEGRAPH_BUILDER_JOB_MAX');
  });

  it('does not add another root’s note to an unmarked index', async () => {
    const marked = await indexedRepo('marked');
    const root = await indexedRepo('unmarked');
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root: marked, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    engine = new MCPEngine({ builder: builderFor(root) });
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('alphaSymbol');
    expect(textOf(result)).not.toContain('CODEGRAPH_BUILDER_JOB_MAX');
    expect(textOf(result)).not.toContain('partial or behind');
  });
});
