import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraph } from '../../../src';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedIndexNote } from '../../../src/extensions/host/builder/stopped-index-note';
import { registerBlastCommand } from '../../../src/extensions/queries/blast/extension';
import { runGrepCommand } from '../../../src/extensions/queries/grep/grep-command';
import { registerOrphansCommand } from '../../../src/extensions/queries/orphans/extension';
import { getGlyphs } from '../../../src/ui/glyphs';

let repo: string;
let stateDir: string;

function git(...args: string[]): void {
  const result = spawnSync('git', [
    '-c', 'user.name=queries-test', '-c', 'user.email=queries-test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function markRoot(root = repo): string {
  const mark = { root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' } as const;
  new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append(mark);
  const note = stoppedIndexNote(mark);
  expect(note).toContain(`The index builder stopped the last open job of ${root} at its time limit`);
  return `${getGlyphs().warn} ${note}\n`;
}

async function runCli(command: 'blast' | 'orphans', base: string) {
  const program = new Command().exitOverride();
  if (command === 'blast') registerBlastCommand(program);
  else registerOrphansCommand(program);
  let stdout = '';
  let stderr = '';
  const previousExitCode = process.exitCode;
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
    await program.parseAsync([command, '-p', path.join(repo, 'src'), '--base', base], { from: 'user' });
    return { stdout, stderr, exitCode: process.exitCode === undefined ? undefined : Number(process.exitCode) };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previousExitCode;
  }
}

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-stopped-')));
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'util.ts'), 'export function helper(): number { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), "import { helper } from './util';\nexport function useA() { return helper(); }\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'C1');
  git('tag', 'C1');
  fs.writeFileSync(path.join(repo, 'src', 'util.ts'), 'export function helper(): number { return 42; }\nexport function lonelyNew() { return 5; }\n');
  git('commit', '-q', '-am', 'C2');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-stopped-state-')));
  vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('grep stopped index note', () => {
  it.each([
    ['text hits', ['helper']],
    ['zero hits', ['no_such_symbol_39287']],
    ['JSON hits', ['helper', '--json']],
    ['JSON zero hits', ['no_such_symbol_39287', '--json']],
  ])('prefixes stderr for %s without changing the answer', async (_label, args) => {
    const unmarked = await runGrepCommand(args, path.join(repo, 'src'));
    expect(unmarked.exitCode).toBe(0);
    expect(unmarked.stderr).not.toContain('The index builder stopped');
    const warning = markRoot();
    const marked = await runGrepCommand(args, path.join(repo, 'src'));
    expect(marked.stdout).toBe(unmarked.stdout);
    expect(marked.exitCode).toBe(unmarked.exitCode);
    expect(marked.stderr).toBe(warning + unmarked.stderr);
  });

  it.each([
    ['missing pattern', []],
    ['bad pattern', ['[']],
    ['unknown scope', ['helper', '--in', 'no-such-directory']],
  ])('does not warn for %s', async (_label, args) => {
    markRoot();
    const result = await runGrepCommand(args, repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('The index builder stopped');
  });

  it('does not warn for a marked root with no index', async () => {
    const unindexed = path.join(stateDir, 'unindexed');
    fs.mkdirSync(unindexed);
    markRoot(unindexed);
    const result = await runGrepCommand(['helper', '-p', unindexed], unindexed);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('The index builder stopped');
  });
});

describe.each(['blast', 'orphans'] as const)('%s stopped index note', (command) => {
  it('warns on stderr without changing stdout or exit code', async () => {
    const unmarked = await runCli(command, 'C1');
    expect(unmarked.exitCode).toBe(0);
    expect(unmarked.stderr).not.toContain('The index builder stopped');
    const warning = markRoot();
    const marked = await runCli(command, 'C1');
    expect(marked.stdout).toBe(unmarked.stdout);
    expect(marked.exitCode).toBe(unmarked.exitCode);
    expect(marked.stderr).toBe(warning + unmarked.stderr);
  });

  it('does not warn on an unknown base error', async () => {
    markRoot();
    const result = await runCli(command, 'no-such-base-39287');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('The index builder stopped');
  });
});
