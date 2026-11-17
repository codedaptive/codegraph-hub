import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import CodeGraph from '../../../src/index';
import type { BuilderClient } from '../../../src/extensions/host/builder/client';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';

let workspace: string;
let root: string;
let stateDir: string;
let savedStateDir: string | undefined;
let engine: MCPEngine;

beforeEach(async () => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stopped-refusal-')));
  root = path.join(workspace, 'repo');
  stateDir = path.join(workspace, 'state');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(stateDir);
  savedStateDir = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = stateDir;
  __setLoadCodeGraphForTests(CodeGraph);
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
  const cg = await CodeGraph.init(root);
  try {
    expect((await cg.indexAll()).success).toBe(true);
  } finally {
    cg.close();
  }
  const builder = {
    ensure: async () => ({ kind: 'ready', root }),
    caughtUp: async () => undefined,
    sync: async () => ({ filesChanged: 0 }),
    release: async () => undefined,
    freshness: () => ({ root, watching: false, degradedReason: 'ended', recovering: false, pendingFiles: [] }),
  } as unknown as BuilderClient;
  engine = new MCPEngine({ builder });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return 9; }\n');
});

afterEach(async () => {
  await engine?.stop();
  __setLoadCodeGraphForTests(null);
  if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
  else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('stale file refusal for a stopped root', () => {
  it('includes one stopped note and index guidance for a marked root', async () => {
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    const text = result.content.map(item => item.text ?? '').join('\n');
    expect(text).toContain('cannot answer from this index');
    expect(result.isError).toBeFalsy();
    expect(text).toContain('src/a.ts');
    expect(text.split('partial or behind')).toHaveLength(2);
    const note = text.split(/\r?\n/).find(line => line.includes('partial or behind'));
    expect(note).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(note).toContain(`codegraph index ${root}`);
    expect(text).not.toContain('codegraph sync');
    expect(text.split(/\r?\n/).find(line => /retry/i.test(line))).toContain(`codegraph index ${root}`);
    expect(text).toContain('narrow the query');
  });

  it('keeps sync guidance and no stopped note for an unmarked root', async () => {
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alphaSymbol', projectPath: root }, undefined, ADMIT_ALL);
    const text = result.content.map(item => item.text ?? '').join('\n');
    expect(text).toContain('cannot answer from this index');
    expect(result.isError).toBeFalsy();
    expect(text).toContain('src/a.ts');
    expect(text).toContain('Retry after a successful codegraph sync, or narrow the query.');
    expect(text).not.toContain('partial or behind');
    expect(text).not.toContain('CODEGRAPH_BUILDER_JOB_MAX');
  });
});
