import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../../../src';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const NOTE = 'partial or behind';
let workspace: string;
let root: string;
let stateDir: string;

function runCli(command: string) {
  return spawnSync(process.execPath, [BIN, command, 'alphaSymbol', '-p', root], {
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

/** The note names the fixture's mark: a `sync` job of `root` over its time limit, and only that limit's variable. */
function expectMarkNote(note: string | undefined): void {
  expect(note).toContain(`last sync job of ${root} at its time limit`);
  expect(note).toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
  expect(note).not.toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/);
  expect(note).toContain(`codegraph index ${root}`);
}

function mark(rootToMark: string): void {
  new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
    root: rootToMark, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
  });
}

describe('stopped root note: CLI', { timeout: 600_000 }, () => {
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stopped-cli-')));
    root = path.join(workspace, 'repo');
    stateDir = path.join(workspace, 'state');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(stateDir);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alphaSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(root);
    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
    } finally {
      cg.close();
    }
  }, 180_000);

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('query serves a marked index with one note on stderr', () => {
    mark(root);
    const result = runCli('query');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alphaSymbol');
    expect(result.stdout).not.toContain(NOTE);
    expect(result.stderr.split(NOTE)).toHaveLength(2);
    const lines = result.stderr.split(/\r?\n/).filter(line => line.includes(NOTE));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(lines[0]).toContain('codegraph index');
    expectMarkNote(lines[0]);
  });

  it.each(['explore', 'node'])('%s serves a marked index with exactly one note across both streams', command => {
    mark(root);
    const result = runCli(command);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alphaSymbol');
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output.split(NOTE).length - 1).toBe(1);
    const lines = output.split(/\r?\n/).filter(line => line.includes(NOTE));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(lines[0]).toContain('codegraph index');
    expectMarkNote(lines[0]);
  });

  it('status reports a marked index with one note on stderr', () => {
    mark(root);
    const result = spawnSync(process.execPath, [BIN, 'status', root], {
      encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, CODEGRAPH_STATE_DIR: stateDir, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
        CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CodeGraph Status');
    expect(result.stderr.split(NOTE)).toHaveLength(2);
    const note = result.stderr.split(/\r?\n/).find(line => line.includes(NOTE));
    expect(note).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(note).toContain(`codegraph index ${root}`);
    expectMarkNote(note);
  });

  it('status of an unmarked index has no stopped note', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other);
    mark(other);
    const result = spawnSync(process.execPath, [BIN, 'status', root], {
      encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, CODEGRAPH_STATE_DIR: stateDir, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
        CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CodeGraph Status');
    expect(result.stderr).not.toContain(NOTE);
    expect(result.stdout).not.toContain(NOTE);
  });

  it('includes the stopped note in the medium prompt-hook context', () => {
    mark(root);
    const result = spawnSync(process.execPath, [BIN, 'prompt-hook'], {
      cwd: root, input: JSON.stringify({ prompt: 'alpha symbol', cwd: root }),
      encoding: 'utf8', timeout: 240_000,
      env: { ...process.env, CODEGRAPH_STATE_DIR: stateDir, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
        CODEGRAPH_NO_PROMPT_HOOK: undefined, CODEGRAPH_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_WASM_RELAUNCHED: '1', NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('<codegraph_context');
    expect(result.stdout).toContain('symbols matching this request');
    expect(result.stdout).toContain('alphaSymbol');
    const block = result.stdout.match(/<codegraph_context\b[\s\S]*?<\/codegraph_context>/)?.[0] ?? '';
    expect(block.split(NOTE)).toHaveLength(2);
    const note = block.split(/\r?\n/).find(line => line.includes(NOTE));
    expect(note).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(note).toContain(`codegraph index ${root}`);
    expectMarkNote(note);
  });

  it('query serves an unmarked index without another root’s note', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other);
    mark(other);
    const result = runCli('query');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('alphaSymbol');
    expect(result.stdout).not.toContain(NOTE);
    expect(result.stderr).not.toContain(NOTE);
  });
});
