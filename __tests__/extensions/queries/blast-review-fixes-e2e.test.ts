/**
 * End-to-end blast tests cover both git diff handling (diff.ts, which marks a pure-deletion range
 * `deletion: true`) and seeding (blast.ts). Each runs
 * `codegraph blast` through `runBlast` on a committed C1 -> C2 diff, so the range a deletion produces comes
 * from git and not from a hand-built object (the hand-built cases are in blast-review-fixes-seeds.test.ts).
 *
 * Every test indexes a fixture repository, which can take more than 5 s on the loaded machine, so each one
 * carries a comment and runs under the 30 s testTimeout of vitest.config.mts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import type { BlastReport } from '../../../src/extensions/queries/blast/blast';
import { runBlast } from '../../../src/extensions/queries/blast/index';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): void {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A git repository whose first commit holds `files`, tagged C1. */
function repoAtC1(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-e2e-'));
  tempRoots.push(root);
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  return root;
}

/** A second commit that writes `files` over the tree. */
function commitC2(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2');
}

async function index(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

/** `runBlast` against C1 in JSON; fails the test on a non-zero exit. */
function blastJson(root: string): BlastReport {
  const r = runBlast(root, { base: 'C1', format: 'json' });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.output) as BlastReport;
}

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe('deleting a whole function after another (C1 -> C2 through git)', () => {
  // C1: u.ts holds a (lines 1-3) and b (lines 4-6); c.ts calls a. C2 deletes b.
  const U_C1 = 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n';
  const U_C2 = 'export function a(): number {\n  return 1;\n}\n';
  const C_SRC = "import { a } from './u';\nexport function useA(): number {\n  return a();\n}\n";

  it('deleting a whole function after another seeds the file, not the function before it', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/u.ts': U_C1, 'src/c.ts': C_SRC });
    commitC2(root, { 'src/u.ts': U_C2 });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds).toEqual([expect.objectContaining({ kind: 'file', path: 'src/u.ts', wholeFile: true })]);
  });

  it('deleting a whole function after another does not report the caller of the function before it', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/u.ts': U_C1, 'src/c.ts': C_SRC });
    commitC2(root, { 'src/u.ts': U_C2 });
    await index(root);
    const report = blastJson(root);
    expect(names(report.impacted)).not.toContain('useA');
  });

  // Control, not a red: it passes before the fix too; a deletion inside one function's body keeps the seed on that function.
  it('control: deleting lines inside a function body seeds that function only, not the one before it', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({
      'src/value.ts': 'export function first(): number {\n  return 1;\n}\n\nexport function compute(): number {\n  const a = 1;\n  const b = a;\n  return a;\n}\n',
    });
    commitC2(root, {
      'src/value.ts': 'export function first(): number {\n  return 1;\n}\n\nexport function compute(): number {\n  const a = 1;\n  return a;\n}\n',
    });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['compute', 'function', false]]);
  });
});

describe('KL-03 (known-limit row, disposition after R2-08)', () => {
  it('KL-03: deleting a module-level side-effect import directly after a function closing line seeds the file, not that function', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // The KL-03 review row recorded this deletion as seeding only the function before the gap, because the gap
    // line is that function's last line. R2-08 gives a gap that no symbol spans its own seed (the file), so the
    // known limit no longer holds for this case. This test pins that behaviour.
    const root = repoAtC1({
      'src/value.ts': "export function a(): number {\n  return 1;\n}\nimport './side';\nexport function b(): number {\n  return 2;\n}\n",
      'src/side.ts': 'export const side = 1;\n',
    });
    commitC2(root, {
      'src/value.ts': 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n',
    });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds).toEqual([expect.objectContaining({ kind: 'file', path: 'src/value.ts', wholeFile: true })]);
  });
});

describe('a blank separator the diff text caps drop is not seeded as code (C1 -> C2 through git)', () => {
  // diff.ts keeps MAX_HUNK_LINES = 24 edited lines per hunk and MAX_FILE_LINES = 200 per file (its counter takes
  // every added or removed line of the file, in patch order). Before the fix seedsForFile saw only the kept text,
  // so a blank separator the caps dropped was not set aside and the file was seeded; it now reads each hunk's
  // shape, counted over every line (`hunkShape` in diff.ts). Each fixture's hunk geometry was checked
  // with `git diff --unified=0`; the header is quoted in the comment of the test that uses it.

  /** A function `name` whose body is an array literal of `count` string elements, each named `<name>-<tag>-<i>`. */
  function arrayFunction(name: string, tag: string, count: number): string {
    const items = Array.from({ length: count }, (_, i) => `    '${name}-${tag}-${i + 1}',`);
    return [`export function ${name}(): string[] {`, '  return [', ...items, '  ];', '}'].join('\n') + '\n';
  }

  const LIB_C1 = 'export function existing(): number {\n  return 1;\n}\n';
  const USER_C1 = "import { existing } from './lib';\nexport function useExisting(): number {\n  return existing();\n}\n";
  // C2 inserts `fresh` (30 lines, then one blank) above `existing`: `@@ -0,0 +1,31 @@`, so the blank is line 31
  // and diff.ts keeps only the first 24 added lines of the hunk.
  const INSERT_ABOVE_C2 = `${arrayFunction('fresh', 'new', 26)}\n${LIB_C1}`;

  it('a 30-line function inserted above an exported function seeds that function, not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/lib.ts': LIB_C1, 'src/user.ts': USER_C1 });
    commitC2(root, { 'src/lib.ts': INSERT_ABOVE_C2 });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds).toEqual([
      expect.objectContaining({ name: 'fresh', kind: 'function', path: 'src/lib.ts', wholeFile: false }),
    ]);
  });

  it('a 30-line function inserted above an exported function does not reach the importer of the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // Same C1 and C2 as the test above. A file seed walks the imports edge from user.ts to lib.ts (blast.test.ts
    // pins that reach), so a file seed here would list user.ts among the impacted.
    const root = repoAtC1({ 'src/lib.ts': LIB_C1, 'src/user.ts': USER_C1 });
    commitC2(root, { 'src/lib.ts': INSERT_ABOVE_C2 });
    await index(root);
    const report = blastJson(root);
    expect(report.impacted.map((i) => i.path)).not.toContain('src/user.ts');
  });

  // Control, not a red: the same insertion, but the line after `fresh` is code, not blank. It seeds the file before
  // and after the fix. A top-level `const` would not serve as that line: the extractor mints a constant node for it
  // (extractVariable in src/extraction/tree-sitter.ts), which owns its own line, so no file seed would follow.
  it('control: a 30-line function inserted above an exported function, followed by a code line, still seeds the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/lib.ts': LIB_C1, 'src/user.ts': USER_C1 });
    commitC2(root, { 'src/lib.ts': `${arrayFunction('fresh', 'new', 26)}console.log('marker');\n${LIB_C1}` });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'file', path: 'src/lib.ts', wholeFile: true })]),
    );
  });

  // C1: four functions f1..f4, each 34 lines, on lines 1-136, then `last` on lines 137-139.
  const LAST_C1 = 'export function last(): number {\n  return 1;\n}\n';
  const CAP_C1 = ['f1', 'f2', 'f3', 'f4'].map((n) => arrayFunction(n, 'old', 30)).join('') + LAST_C1;
  // C2 rewrites every element of f1..f4: four hunks `@@ -3,30 +3,30 @@`, `@@ -37,30 +37,30 @@`, `@@ -71,30 +71,30 @@`
  // and `@@ -105,30 +105,30 @@`, 60 edited lines each (240 in all, past the 200-line file cap). Then `fresh` (3 lines)
  // and a blank go above `last`: `@@ -136,0 +137,4 @@`, a hunk the file cap drops whole, blank included.
  const CAP_C2 = ['f1', 'f2', 'f3', 'f4'].map((n) => arrayFunction(n, 'new', 30)).join('')
    + 'export function fresh(): number {\n  return 2;\n}\n\n' + LAST_C1;

  it('a short function and its blank separator, after earlier edits fill the per-file cap, seed that function, not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/lib.ts': CAP_C1 });
    commitC2(root, { 'src/lib.ts': CAP_C2 });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds.filter((s) => s.wholeFile)).toEqual([]);
    expect(names(report.seeds)).toContain('fresh');
  });
});
