/**
 * Validation (host #4630): the built CLI's `codegraph init` retries a root stopped at a builder job limit.
 *
 * Measures: `init --yes <root>` from dist/bin/codegraph.js on an already-indexed git root, with the stopped mark
 * the builder writes (builder-ended-jobs.jsonl in CODEGRAPH_STATE_DIR). Threshold: on a marked root init exits 0,
 * says it is rebuilding the index, clears that root's mark and indexes a file added since; on an unmarked root it
 * answers "Already initialized" and builds nothing; a mark on another root is kept. Source: S-69 and its 2026-11-16
 * amendment (only an explicit `index` or `init` of that root clears its mark), docs/SPEC.md §3, S-94.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../../../src';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';
import { gitInitTempRoot } from '../../helpers/git-init-temp-root';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
let workspace: string;
let root: string;
let stateDir: string;

function mark(markedRoot: string): void {
  new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
    root: markedRoot, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
  });
}

function runInit() {
  return spawnSync(process.execPath, [BIN, 'init', '--yes', root], {
    encoding: 'utf8', timeout: 240_000,
    env: {
      ...process.env,
      CODEGRAPH_STATE_DIR: stateDir,
      CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
      CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1',
    },
  });
}

function indexedNewFile(): boolean {
  const cg = CodeGraph.openSync(root, { readOnly: true });
  try { return cg.getFile('new.ts') !== null; } finally { cg.close(); }
}

describe('codegraph init on a stopped root (built CLI)', { timeout: 600_000 }, () => {
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-init-stopped-')));
    root = path.join(workspace, 'repo');
    stateDir = path.join(workspace, 'state');
    fs.mkdirSync(root);
    fs.mkdirSync(stateDir);
    root = gitInitTempRoot(root);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export function firstSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try { expect((await cg.indexAll()).success).toBe(true); } finally { cg.close(); }
    fs.writeFileSync(path.join(root, 'new.ts'), 'export function newSymbol() { return 2; }\n');
    expect(indexedNewFile()).toBe(false);
  }, 180_000);

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('rebuilds a marked root, clears its mark and indexes the file added since', () => {
    mark(root);
    expect(stoppedRootMark(root, stateDir)).not.toBeNull();
    const result = runInit();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('rebuilding the index');
    expect(stoppedRootMark(root, stateDir)).toBeNull();
    expect(indexedNewFile()).toBe(true);
  });

  it('answers "Already initialized" on an unmarked root and builds nothing', () => {
    const result = runInit();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(`Already initialized in ${root}`);
    expect(output).not.toContain('rebuilding the index');
    expect(indexedNewFile()).toBe(false);
  });

  it('keeps the mark of another root and does not rebuild this one', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other);
    mark(other);
    const result = runInit();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(`Already initialized in ${root}`);
    expect(stoppedRootMark(other, stateDir)).toEqual({
      root: other, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    expect(indexedNewFile()).toBe(false);
  });
});
