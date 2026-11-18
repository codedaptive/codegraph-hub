import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraph } from '../../../src';
import type { IndexWriter } from '../../../src/extensions/host/builder/cli-route';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';

const REBUILD = path.resolve(__dirname, '../../../src/extensions/host/rebuildIndex');
let workspace: string;
let root: string;
let stateDir: string;

function indexedNewFile(): boolean {
  const cg = CodeGraph.openSync(root, { readOnly: true });
  try { return cg.getFile('new.ts') !== null; } finally { cg.close(); }
}

describe('rebuildIndex', { timeout: 90_000 }, () => {
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-index-')));
    root = path.join(workspace, 'repo');
    stateDir = path.join(workspace, 'state');
    fs.mkdirSync(root);
    fs.mkdirSync(stateDir);
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export function firstSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { expect((await cg.indexAll()).success).toBe(true); } finally { cg.close(); }
    fs.writeFileSync(path.join(root, 'new.ts'), 'export function newSymbol() { return 2; }\n');
    expect(indexedNewFile()).toBe(false);
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    expect(stoppedRootMark(root, stateDir)).not.toBeNull();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('rebuilds a marked root, clears its mark and indexes the new file', async () => {
    const run = vi.fn(async (writer: IndexWriter) => {
      try { return (await writer.indexAll()).success; } finally { writer.destroy(); }
    });
    const { rebuildIndex } = await import(REBUILD);
    expect(await rebuildIndex(root, {}, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedRootMark(root, stateDir)).toBeNull();
    expect(indexedNewFile()).toBe(true);
  });

  it('returns false and retains the mark when indexing fails', async () => {
    const run = vi.fn(async (writer: IndexWriter) => { writer.destroy(); return false; });
    const { rebuildIndex } = await import(REBUILD);
    expect(await rebuildIndex(root, {}, run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedRootMark(root, stateDir)).toEqual({
      root, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
  });
});
