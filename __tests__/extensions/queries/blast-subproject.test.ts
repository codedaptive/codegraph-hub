/**
 * `codegraph blast` on a CodeGraph project that is a subdirectory of its git
 * repository.
 *
 * The repo holds `pkg/` (the indexed project) and `other/` (outside it). C2
 * edits the body of `helper` in pkg/src/util.ts and a file in other/ in the
 * same commit. CodeGraph file ids are relative to `pkg/` (`src/util.ts`), so the
 * diff has to be read relative to `pkg/` and restricted to it: read from the
 * repo root instead, the changed file is `pkg/src/util.ts`, matches no index
 * entry and is reported unindexed, and other/ leaks into `changed`.
 *
 * Indexing the fixture takes well under a second, so it runs once in beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import type { BlastReport } from '../../../src/extensions/queries/blast/blast';
import { runBlast } from '../../../src/extensions/queries/blast/index';

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** `helper` spans L1-L3 of pkg/src/util.ts. */
const UTIL = 'export function helper(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n';
const USE = "import { helper } from './util';\n\nexport function useHelper(): number {\n  return helper();\n}\n";

describe('blast on a CodeGraph project in a subdirectory of the git repo', () => {
  let repo = '';
  let report: BlastReport;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-sub-'));
    git(repo, 'init', '-q');
    write(repo, 'pkg/src/util.ts', UTIL);
    write(repo, 'pkg/src/use.ts', USE);
    write(repo, 'other/outside.ts', 'export function outside(): number {\n  return 0;\n}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'C1');
    git(repo, 'tag', 'C1');
    write(repo, 'pkg/src/util.ts', UTIL.replace('return 1;', 'return 42;'));
    write(repo, 'other/outside.ts', 'export function outside(): number {\n  return 7;\n}\n');
    git(repo, 'commit', '-q', '-am', 'C2: helper body and a file outside pkg');

    const pkg = path.join(repo, 'pkg');
    const cg = await CodeGraph.init(pkg);
    await cg.indexAll();
    cg.close();

    const r = runBlast(pkg, { base: 'C1', format: 'json' });
    expect(r.exitCode).toBe(0);
    report = JSON.parse(r.output) as BlastReport;
  }, 30_000);

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('seeds the changed function by name, from a project-relative path', () => {
    expect(report.seeds.map((s) => [s.name, s.wholeFile])).toEqual([['helper', false]]);
    expect(report.unindexed).toEqual([]);
  });

  it('lists only the project file in changed, relative to the project root', () => {
    expect(report.changed.map((c) => [c.path, c.ranges])).toEqual([['src/util.ts', [{ start: 2, end: 2 }]]]);
  });
});
