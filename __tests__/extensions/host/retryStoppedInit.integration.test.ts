import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraph } from '../../../src';
import type { IndexWriter } from '../../../src/extensions/host/builder/cli-route';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';

const RETRY = path.resolve(__dirname, '../../../src/extensions/host/retryStoppedInit');
const ENGINE = path.resolve(__dirname, '../../../src/index');
let workspace: string;
let root: string;
let stateDir: string;

function mark(markedRoot: string): void {
  new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
    root: markedRoot, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
  });
}

function indexedNewFile(): boolean {
  const cg = CodeGraph.openSync(root, { readOnly: true });
  try { return cg.getFile('new.ts') !== null; } finally { cg.close(); }
}

const runIndexOn = async (writer: IndexWriter): Promise<boolean> => {
  try { return (await writer.indexAll()).success; } finally { writer.destroy(); }
};

describe('retryStoppedInit', { timeout: 90_000 }, () => {
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-retry-stopped-')));
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('rebuilds a marked root, clears its mark and indexes the new file', async () => {
    mark(root);
    expect(stoppedRootMark(root, stateDir)).not.toBeNull();
    const run = vi.fn(runIndexOn);
    const { retryStoppedInit } = await import(RETRY);
    expect(await retryStoppedInit(root, {}, { runIndexOn: run, loadEngine: () => import(ENGINE), onRetry: () => {} })).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedRootMark(root, stateDir)).toBeNull();
    expect(indexedNewFile()).toBe(true);
  });

  it('leaves an unmarked root untouched and does not invoke the indexer', async () => {
    const run = vi.fn(runIndexOn);
    const { retryStoppedInit } = await import(RETRY);
    expect(await retryStoppedInit(root, {}, { runIndexOn: run, loadEngine: () => import(ENGINE), onRetry: () => {} })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(indexedNewFile()).toBe(false);
  });

  it('preserves another root’s mark when retrying this root', async () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other);
    mark(root);
    mark(other);
    const otherMark = { root: other, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z' };
    expect(stoppedRootMark(other, stateDir)).toEqual(otherMark);
    const { retryStoppedInit } = await import(RETRY);
    expect(await retryStoppedInit(root, {}, { runIndexOn: runIndexOn, loadEngine: () => import(ENGINE), onRetry: () => {} })).toBe(true);
    expect(stoppedRootMark(root, stateDir)).toBeNull();
    expect(stoppedRootMark(other, stateDir)).toEqual(otherMark);
  });

  it('returns false and retains the mark when indexing fails', async () => {
    mark(root);
    expect(stoppedRootMark(root, stateDir)).not.toBeNull();
    const run = vi.fn(async (writer: IndexWriter) => { writer.destroy(); return false; });
    const { retryStoppedInit } = await import(RETRY);
    expect(await retryStoppedInit(root, {}, { runIndexOn: run, loadEngine: () => import(ENGINE), onRetry: () => {} })).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedRootMark(root, stateDir)).toEqual({
      root, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
  });
});
