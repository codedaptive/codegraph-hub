import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodeGraph } from '../../../src';
import { registerBlastCommand } from '../../../src/extensions/queries/blast/extension';
import { runGrepCommand } from '../../../src/extensions/queries/grep/grep-command';
import { registerOrphansCommand } from '../../../src/extensions/queries/orphans/extension';

let indexed = '';
let unindexed = '';
let repo = '';

async function runRead(command: 'grep' | 'blast' | 'orphans', root: string) {
  if (command === 'grep') return runGrepCommand(['TOKEN', '--path', root], root);

  const program = new Command().exitOverride();
  if (command === 'blast') registerBlastCommand(program);
  else registerOrphansCommand(program);
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    process.exitCode = undefined;
    const args = ['node', 'codegraph', command, '--path', root];
    if (command === 'orphans') args.push('--base', 'HEAD');
    await program.parseAsync(args);
    return { stdout, stderr, exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = undefined;
  }
}

beforeAll(async () => {
  indexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-refusal-')));
  unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-unindexed-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-read-git-')));
  const init = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  for (const root of [indexed, repo]) {
    fs.writeFileSync(path.join(root, 'fixture.ts'), 'export function example() { return "TOKEN"; }\n');
    const cg = await CodeGraph.init(root, { index: true });
    cg.close();
  }
}, 30_000);

afterAll(() => {
  for (const root of [indexed, unindexed, repo]) {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe.each(['grep', 'blast', 'orphans'] as const)('%s read root', (command) => {
  it('refuses an indexed non-git folder without opt-in', async () => {
    const result = await runRead(command, indexed);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('✗ ')).toBe(true);
    expect(result.stderr).toContain(indexed);
    expect(result.stderr).toContain('is not in a git repository');
  });

  it('preserves the no-index answer for an unindexed non-git folder', async () => {
    const result = await runRead(command, unindexed);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('is not in a git repository');
  });
});

it('grep reads an indexed git folder', async () => {
  const result = await runRead('grep', repo);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
});
