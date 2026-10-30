/**
 * Fresh answers, CLI surface: `--fresh` /
 * `--checkpoint` on the query commands and the `codegraph checkpoint` command,
 * driven through the built binary (dist/bin/codegraph.js, built from src by the
 * vitest globalSetup) the way __tests__/cli-sync.test.ts drives `sync`.
 *
 * Expected head and dirtyHash are rebuilt from git output here (the formula
 * is computeUncommittedHash's in src/extensions/host/fresh/checkpoint.ts), so the tests
 * do not trust the code under test for
 * the values they compare against.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const CHECKPOINT_PREFIX = 'codegraph-checkpoint ';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** dirtyHash as computeUncommittedHash (src/extensions/host/fresh/checkpoint.ts) defines it: sha256 over sorted `${path}\0${blob}\n` entries. */
function dirtyHashOf(entries: Array<[string, string]>): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const [p, blob] of sorted) h.update(`${p}\0${blob}\n`);
  return h.digest('hex');
}

/**
 * One child, no daemon, no wasm-flag re-exec, no telemetry or prompt hook.
 * CODEGRAPH_FRESH_TIMEOUT_MS is removed unless the test sets it, so an
 * inherited value cannot change the bound.
 */
function runCli(args: string[], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
    CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    NODE_NO_WARNINGS: '1', NO_COLOR: '1',
  };
  delete env.CODEGRAPH_FRESH_TIMEOUT_MS;
  Object.assign(env, extra);
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000, env });
}

/** The single `codegraph-checkpoint {...}` stderr line, parsed. */
function checkpointLine(stderr: string): Record<string, unknown> {
  const lines = stderr.split(/\r?\n/).filter(l => l.startsWith(CHECKPOINT_PREFIX));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice(CHECKPOINT_PREFIX.length));
}

describe('fresh answers: CLI', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-cli-')));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', 'Fresh Test']);
    git(dir, ['config', 'user.email', 'fresh@example.invalid']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'c.ts'), 'export function gamma() { return 3; }\n');
    // .codegraph/ must not show up in `git status`, or dirtyHash would hash the index itself.
    fs.writeFileSync(path.join(dir, '.gitignore'), '.codegraph/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
    } finally {
      cg.destroy();
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** An unsynced edit: a.ts gains `freshlyAdded`. */
  function editA(): void {
    fs.appendFileSync(path.join(dir, 'a.ts'), 'export function freshlyAdded() {}\n');
  }

  // Over 5 s possible: one CLI spawn whose fresh wait syncs the index inside the child, on a loaded machine.
  it('C1 query --fresh --json finds the edit and reports a fresh checkpoint on stderr', () => {
    editA();
    const head = git(dir, ['rev-parse', 'HEAD']);
    const r = runCli(['query', 'freshlyAdded', '-p', dir, '--json', '--fresh']);
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toMatch(/unknown option/i);
    expect(r.status).toBe(0);
    const results = JSON.parse(r.stdout) as Array<{ node: { name: string } }>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.some(x => x.node.name === 'freshlyAdded')).toBe(true);
    const cp = checkpointLine(r.stderr);
    expect(cp.head).toBe(head);
    expect(cp.fresh).toBe(true);
    expect(cp.pending).toBe(0);
  });

  // Over 5 s possible: one CLI spawn on a loaded machine.
  it('C2 checkpoint --json with an edit pending exits 3 with pending 1 and the git dirtyHash', () => {
    editA();
    const blob = git(dir, ['hash-object', 'a.ts']);
    const r = runCli(['checkpoint', dir, '--json']);
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toMatch(/unknown command/i);
    expect(r.status).toBe(3);
    const cp = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(cp.pending).toBe(1);
    expect(cp.fresh).toBe(false);
    expect(cp.head).toBe(git(dir, ['rev-parse', 'HEAD']));
    expect(cp.dirtyHash).toBe(dirtyHashOf([['a.ts', blob]]));
  });

  // Over 5 s possible: two CLI spawns, the first syncing the index, on a loaded machine.
  it('C3 checkpoint --fresh --json catches up (exit 0, pending 0); a plain checkpoint then exits 0', () => {
    editA();
    const fresh = runCli(['checkpoint', dir, '--fresh', '--json']);
    expect(fresh.error).toBeUndefined();
    expect(fresh.stderr).not.toMatch(/unknown command/i);
    expect(fresh.status).toBe(0);
    const cp = JSON.parse(fresh.stdout.trim()) as Record<string, unknown>;
    expect(cp.pending).toBe(0);
    expect(cp.fresh).toBe(true);

    const after = runCli(['checkpoint', dir, '--json']);
    expect(after.status).toBe(0);
    const cp2 = JSON.parse(after.stdout.trim()) as Record<string, unknown>;
    expect(cp2.pending).toBe(0);
  });

  // Over 5 s possible: one CLI spawn on a loaded machine.
  it('C4 query --fresh with CODEGRAPH_FRESH_TIMEOUT_MS=0 and an edit exits 3, stdout still JSON', () => {
    editA();
    const r = runCli(['query', 'freshlyAdded', '-p', dir, '--fresh', '--json'], { CODEGRAPH_FRESH_TIMEOUT_MS: '0' });
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toMatch(/unknown option/i);
    expect(r.status).toBe(3);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    const cp = checkpointLine(r.stderr);
    expect(cp.fresh).toBe(false);
    expect(cp.timedOut).toBe(true);
  });

  // Over 5 s possible: one CLI spawn on a loaded machine.
  it('C5 checkpoint on a directory that is not initialized exits 1', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-cli-bare-'));
    try {
      const r = runCli(['checkpoint', bare]);
      expect(r.error).toBeUndefined();
      expect(r.stderr).not.toMatch(/unknown command/i);
      expect(r.status).toBe(1);
      expect(r.stderr.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
