/**
 * Tests for what `codegraph blast` seeds from a changed line, the test signal for a component and for an
 * area with no behaviour, and the hunk lines of the JSON report.
 *
 * The deletion cases build their ChangedFile by hand (R2-08), including the `deletion: true` marker;
 * the git-driven cases use only non-deletion ranges.
 *
 * Every test indexes a fixture repository, which can take more than 5 s on the loaded machine, so the
 * tests that index carry a comment and run under the 30 s testTimeout of vitest.config.mts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import type { ChangedFile, Hunk } from '../../../src/extensions/queries/blast/diff';
import { blastRadius, type BlastReport, type Seed } from '../../../src/extensions/queries/blast/blast';
import { jsonReport } from '../../../src/extensions/queries/blast/render';
import { runBlast } from '../../../src/extensions/queries/blast/index';
import { openBlastStore } from '../../../src/extensions/queries/blast/store';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-seeds-'));
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

/** The seeds the walk starts from for one hand-built changed file, on the index at `root`. */
function seedsFor(root: string, file: ChangedFile): Seed[] {
  const store = openBlastStore(root);
  try {
    return blastRadius(store, [file], 'hand-built', 2).seeds;
  } finally {
    store.close();
  }
}

/** A hand-built modified file at `src/u.ts` with one line changed (line 2), text kept on both sides. A fresh object per call. */
function modifiedU(): ChangedFile {
  return {
    path: 'src/u.ts',
    status: 'modified',
    ranges: [{ start: 2, end: 2 }],
    hunks: [{
      start: 2,
      end: 2,
      lines: [
        { n: null, sign: '-', text: '  return 1;' },
        { n: 2, sign: '+', text: '  return 2;' },
      ],
      dropped: 0,
    }],
  };
}

/** The blast report for `modifiedU()` on the index at `root`, built without git. */
function handBuiltReport(root: string): BlastReport {
  const store = openBlastStore(root);
  try {
    return blastRadius(store, [modifiedU()], 'hand-built', 2);
  } finally {
    store.close();
  }
}

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe('R1-23: each changed line seeds its own innermost owner', () => {
  const VALUE_C1 = 'class First {}\nclass Second {}\nexport class Changed extends First {\n  run() { return 1; }\n}\n';
  const VALUE_C2 = 'class First {}\nclass Second {}\nexport class Changed extends Second {\n  run() { return 2; }\n}\n';
  const USE = "import { Changed } from './value';\nexport class Child extends Changed {}\nexport function construct() { return new Changed(); }\n";

  it('a hunk changing a class declaration line and a line of its method seeds both the class and the method', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/value.ts': VALUE_C1, 'src/use.ts': USE });
    commitC2(root, { 'src/value.ts': VALUE_C2 });
    await index(root);
    const report = blastJson(root);
    expect(report.changed[0].ranges).toEqual([{ start: 3, end: 4 }]);
    expect(report.seeds).toHaveLength(2);
    expect(report.seeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Changed', kind: 'class', wholeFile: false }),
      expect.objectContaining({ name: 'run', kind: 'method', wholeFile: false }),
    ]));
  });

  it('the class seeded beside its method reaches the classes and functions that depend on it', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/value.ts': VALUE_C1, 'src/use.ts': USE });
    commitC2(root, { 'src/value.ts': VALUE_C2 });
    await index(root);
    const report = blastJson(root);
    expect(names(report.impacted)).toEqual(expect.arrayContaining(['Child', 'construct']));
  });
});

describe('R1-24: a changed line outside every symbol seeds the file beside the symbols', () => {
  it.each([true, false])(
    'a changed import line outside every symbol seeds the file alongside the function it sits by (one hunk=%s)',
    async (oneHunk) => {
      // Indexes a fixture repo: can pass 5 s under load.
      const before = oneHunk
        ? "import './before';\nexport function helper() { return 1; }\n"
        : "import './before';\n\nexport function helper() {\n  return 1;\n}\n";
      const root = repoAtC1({
        'src/value.ts': before,
        'src/before.ts': 'console.log(1);\n',
        'src/after.ts': 'console.log(2);\n',
      });
      commitC2(root, { 'src/value.ts': before.replace('./before', './after').replace('return 1;', 'return 2;') });
      await index(root);
      const report = blastJson(root);
      expect(report.seeds).toHaveLength(2);
      expect(report.seeds).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'helper', kind: 'function', wholeFile: false }),
        expect.objectContaining({ kind: 'file', path: 'src/value.ts', wholeFile: true }),
      ]));
    },
  );

  it('commenting out a module-level import beside a function edit seeds the file alongside the function', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const before = "import './before';\nexport function helper() { return 1; }\n";
    const root = repoAtC1({ 'src/value.ts': before, 'src/before.ts': 'console.log(1);\n' });
    commitC2(root, { 'src/value.ts': "// import './before';\nexport function helper() { return 2; }\n" });
    await index(root);
    const report = blastJson(root);
    expect(report.changed[0].ranges).toEqual([{ start: 1, end: 2 }]);
    expect(report.seeds).toHaveLength(2);
    expect(report.seeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'helper', kind: 'function', wholeFile: false }),
      expect.objectContaining({ kind: 'file', wholeFile: true }),
    ]));
  });

  // Control, not a red: it passes before the fix too, and pins that a body-only edit keeps the file out of the seeds.
  it('control: an edit confined to a function body seeds that function and not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const before = 'export function helper(): number {\n  return 1;\n}\n';
    const root = repoAtC1({ 'src/value.ts': before });
    commitC2(root, { 'src/value.ts': before.replace('return 1;', 'return 2;') });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['helper', 'function', false]]);
  });

  // Control, not a red: it passes before the fix too, and pins that blank separators a hunk adds beside a new function are set aside.
  it('control: a new function whose hunk also adds a blank separator seeds only the new function, not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const before = 'export function first(): number {\n  return 1;\n}\n';
    const root = repoAtC1({ 'src/value.ts': before });
    commitC2(root, { 'src/value.ts': `${before}\nexport function second(): number {\n  return 2;\n}\n` });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['second', 'function', false]]);
  });

  // Control, not a red: it passes before the fix too; the whole range is blank, so nothing is set aside and the file is seeded.
  it('control: a hunk that adds only blank lines outside every symbol seeds the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const before = 'export function helper(): number {\n  return 1;\n}\n';
    const root = repoAtC1({ 'src/value.ts': before });
    commitC2(root, { 'src/value.ts': `\n\n${before}` });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds.map((s) => [s.kind, s.wholeFile])).toEqual([['file', true]]);
  });
});

describe('R1-25: a memo or forwardRef component is behavioural code', () => {
  it.each(['memo', 'forwardRef'])('counts a changed %s component as behavioural code reached by tests', async (wrapper) => {
    // Indexes a fixture repo: can pass 5 s under load.
    const source = (label: string): string =>
      `import { ${wrapper} } from 'react';\nexport const Card = ${wrapper}((props) => <div>${label}</div>);\n`;
    const root = repoAtC1({
      'src/Card.tsx': source('before'),
      'tests/Card.test.tsx': "import { Card } from '../src/Card';\nexport function check() { return <Card />; }\n",
    });
    commitC2(root, { 'src/Card.tsx': source('after') });
    await index(root);
    const report = blastJson(root);
    expect(report.seeds).toEqual([expect.objectContaining({ name: 'Card', kind: 'component', wholeFile: false })]);
    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]).toMatchObject({
      behavioural: 1, reached: 1, tests: 'stale', testFiles: ['tests/Card.test.tsx'],
    });
  });

  it('an area whose changed symbols are all types reads "no function, method, class or component changed here"', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/types.ts': 'export interface Shape {\n  sides: number;\n}\n' });
    commitC2(root, { 'src/types.ts': 'export interface Shape {\n  sides: number;\n  name: string;\n}\n' });
    await index(root);
    const r = runBlast(root, { base: 'C1', format: 'markdown' });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('no function, method, class or component changed here');
    expect(r.output).not.toContain('no function, method or class changed here');
  });
});

describe('R2-07: the JSON report carries each hunk line as {n, sign}', () => {
  it('writes each changed hunk line with its number and sign only, for indexed code and other files alike', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\n',
      '.env': 'API_KEY=OLDSECRET\n',
    });
    commitC2(root, {
      'src/u.ts': 'export function a(): number {\n  return 2;\n}\n',
      '.env': 'API_KEY=NEWSECRET\n',
    });
    await index(root);
    const report = blastJson(root);
    const lines = report.changed.flatMap((c) => c.hunks.flatMap((h) => h.lines));
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['n', 'sign']);
    const indexedFile = report.changed.find((c) => c.path === 'src/u.ts');
    expect(indexedFile?.hunks[0].lines).toEqual([{ n: null, sign: '-' }, { n: 2, sign: '+' }]);
  });

  it('jsonReport writes each hunk line of the report it is given as {n, sign}', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/u.ts': 'export function a(): number {\n  return 1;\n}\n' });
    commitC2(root, { 'src/u.ts': 'export function a(): number {\n  return 2;\n}\n' });
    await index(root);
    const out = jsonReport(handBuiltReport(root));
    expect(out).not.toContain('return 1');
    expect(out).not.toContain('return 2');
    const lines = (JSON.parse(out) as BlastReport).changed.flatMap((c) => c.hunks.flatMap((h) => h.lines));
    expect(lines).toEqual([{ n: null, sign: '-' }, { n: 2, sign: '+' }]);
  });

  it('keeps a changed properties value out of the JSON report, and still lists the file with its hunk lines', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({
      'src/main/resources/application.properties': 'db.password=OLDSECRET\n',
      'src/u.ts': 'export function a(): number {\n  return 1;\n}\n',
    });
    commitC2(root, { 'src/main/resources/application.properties': 'db.password=NEWSECRET\n' });
    await index(root);
    const r = runBlast(root, { base: 'C1', format: 'json' });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain('OLDSECRET');
    expect(r.output).not.toContain('NEWSECRET');
    const props = (JSON.parse(r.output) as BlastReport).changed.find(
      (c) => c.path === 'src/main/resources/application.properties',
    );
    expect(props).toMatchObject({ status: 'modified', ranges: [{ start: 1, end: 1 }] });
    expect(props?.hunks.map((h) => h.lines)).toEqual([[{ n: null, sign: '-' }, { n: 1, sign: '+' }]]);
  });

  // Control, not a red: it passes before the fix too, and pins that jsonReport leaves the report it is given alone.
  it('control: jsonReport does not mutate the report it is given, whose hunk lines still carry text', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/u.ts': 'export function a(): number {\n  return 1;\n}\n' });
    commitC2(root, { 'src/u.ts': 'export function a(): number {\n  return 2;\n}\n' });
    await index(root);
    const report = handBuiltReport(root);
    const before = JSON.stringify(report);
    jsonReport(report);
    expect(JSON.stringify(report)).toBe(before);
    const lines = report.changed.flatMap((c) => c.hunks.flatMap((h) => h.lines));
    expect(lines.every((l) => 'text' in l)).toBe(true);
  });

  // Control, not a red: it passes before the fix too, and pins the rest of the report shape, which this change leaves alone.
  it('control: the rest of the JSON report keeps its shape (top-level keys, file and hunk keys)', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    const root = repoAtC1({ 'src/u.ts': 'export function a(): number {\n  return 1;\n}\n' });
    commitC2(root, { 'src/u.ts': 'export function a(): number {\n  return 2;\n}\n' });
    await index(root);
    const report = JSON.parse(jsonReport(handBuiltReport(root))) as BlastReport;
    expect(Object.keys(report).sort()).toEqual([
      'areas', 'basis', 'changed', 'deleted', 'depth', 'impacted', 'modules', 'seeds', 'testModules', 'unindexed',
    ]);
    expect(Object.keys(report.changed[0]).sort()).toEqual(['hunks', 'path', 'ranges', 'status']);
    expect(Object.keys(report.changed[0].hunks[0]).sort()).toEqual(['dropped', 'end', 'lines', 'start']);
  });
});

describe('R2-08: a deletion range seeds by the gap it leaves (hand-built ranges)', () => {
  /** A pure-deletion range and hunk after `line`, the line before the gap, whose removed lines are `texts`. */
  function deletedAfter(file: string, line: number, texts: string[]): ChangedFile {
    const hunk: Hunk = {
      start: line,
      end: line,
      deletion: true,
      lines: texts.map((text) => ({ n: null, sign: '-' as const, text })),
      dropped: 0,
    };
    return { path: file, status: 'modified', ranges: [{ start: line, end: line, deletion: true }], hunks: [hunk] };
  }

  it('a deletion gap after the last line of function a seeds the file, not a', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // The post-image keeps only `a` (lines 1-3); the removed `b` sat after line 3, so the gap follows a's closing line.
    const root = repoAtC1({ 'src/u.ts': 'export function a(): number {\n  return 1;\n}\n' });
    await index(root);
    const seeds = seedsFor(root, deletedAfter('src/u.ts', 3, [
      'export function b(): number {', '  return 2;', '}',
    ]));
    expect(seeds).toEqual([expect.objectContaining({ kind: 'file', path: 'src/u.ts', wholeFile: true })]);
  });

  // Control, not a red: it passes before the fix too; a gap inside a function body keeps the seed on that function.
  it('control: a deletion inside a function body seeds that function and not the file', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // The post-image is compute (lines 1-4); the removed `const b = a;` sat between lines 2 and 3, so the gap is inside compute.
    const root = repoAtC1({ 'src/value.ts': 'export function compute(): number {\n  const a = 1;\n  return a;\n}\n' });
    await index(root);
    const seeds = seedsFor(root, deletedAfter('src/value.ts', 2, ['  const b = a;']));
    expect(seeds.map((s) => [s.name, s.kind, s.wholeFile])).toEqual([['compute', 'function', false]]);
  });

  it('an all-blank deletion with no spanning symbol seeds neither the file nor a symbol (a documented limit)', async () => {
    // Indexes a fixture repo: can pass 5 s under load.
    // Documented limit: the removed line is blank and kept in the hunk, so it is set aside as a blank separator
    // would be. A blank line removed between two functions therefore seeds nothing; a dependent that relied on it
    // is not reported from this diff.
    const root = repoAtC1({
      'src/value.ts': 'export function first(): number {\n  return 1;\n}\n\nexport function second(): number {\n  return 2;\n}\n',
    });
    await index(root);
    const seeds = seedsFor(root, deletedAfter('src/value.ts', 3, ['']));
    expect(seeds).toEqual([]);
  });
});
