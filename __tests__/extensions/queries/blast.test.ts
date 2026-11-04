/**
 * `codegraph blast` run on a real CodeGraph index of a fixture git repo.
 *
 * Two indexed repos share one base commit (tag `C1`), each with its own
 * second commit, because `C1...HEAD` is cumulative and the vectors need
 * different diffs:
 *   - repo A: C2 edits only the body of `helper`;
 *   - repo B: C2 edits the body of `Cache.get`, adds a top-of-file comment to
 *     src/b.ts, deletes lib/standalone.ts and adds README.md.
 * The dirty-tree basis test and the no-index error need no index, so they use
 * plain git repos.
 *
 * Indexing the fixture takes about 0.4 s, so each repo is indexed once at
 * its final HEAD in its describe's beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { changedFiles, refExists } from '../../../src/extensions/queries/blast/diff';
import { BLAST_WALK_KINDS, blastRadius, type BlastReport } from '../../../src/extensions/queries/blast/blast';
import { markdownReport, textReport } from '../../../src/extensions/queries/blast/render';
import { blastToolHandler, parseBlastArgv, runBlast } from '../../../src/extensions/queries/blast/index';
import { openBlastStore } from '../../../src/extensions/queries/blast/store';

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

/** The C1 tree. Line numbers matter: `helper` spans L1-L3 of src/util.ts, `Cache.get` L2-L4 of src/cache.ts. */
const C1_FILES: Record<string, string> = {
  'src/util.ts': 'export function helper(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n',
  'src/a.ts': "import { helper } from './util';\n\nexport function useA(): number {\n  return helper();\n}\n",
  'src/b.ts': "import { useA } from './a';\n\nexport function useB(): number {\n  return useA();\n}\n",
  'src/c.ts': "import { useB } from './b';\n\nexport function useC(): number {\n  return useB();\n}\n",
  // Calls `other`, so a walk that wrongly seeds `other` (or the whole util.ts) reaches it.
  'src/d.ts': "import { other } from './util';\n\nexport function useOther(): number {\n  return other();\n}\n",
  'src/cache.ts': 'export class Cache {\n  get(): number {\n    return 1;\n  }\n\n  put(): void {\n    return;\n  }\n}\n',
  'tests/util.test.ts': "import { helper } from '../src/util';\n\nexport function checkHelper(): boolean {\n  return helper() === 1;\n}\n",
  'lib/standalone.ts': 'export function lonely(): number {\n  return 0;\n}\n',
};

/** A temp git repo at commit C1 (tagged `C1`). */
function repoAtC1(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  return root;
}

async function index(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

describe('blast on repo A (C2 edits the body of helper)', () => {
  let root = '';
  let report: BlastReport;

  beforeAll(async () => {
    root = repoAtC1('cg-blast-a-');
    write(root, 'src/util.ts', C1_FILES['src/util.ts'].replace('return 1;', 'return 42;'));
    git(root, 'commit', '-q', '-am', 'C2: helper body');
    await index(root);
    const r = runBlast(root, { base: 'C1', format: 'json' });
    expect(r.exitCode).toBe(0);
    report = JSON.parse(r.output) as BlastReport;
  }, 30_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('R2 walks exactly the seven dependency edge kinds', () => {
    expect([...BLAST_WALK_KINDS].sort()).toEqual(
      ['calls', 'decorates', 'extends', 'implements', 'imports', 'instantiates', 'references'],
    );
  });

  it('V1 basis is the merge-base range C1...HEAD at default depth 2', () => {
    expect(report.basis).toBe('C1...HEAD');
    expect(report.depth).toBe(2);
    expect(report.changed.map((c) => [c.path, c.status])).toEqual([['src/util.ts', 'modified']]);
    expect(report.changed[0].ranges).toEqual([{ start: 2, end: 2 }]);
  });

  it('V1 seeds only helper, as a symbol seed, not other or the file', () => {
    expect(report.seeds).toHaveLength(1);
    expect(report.seeds[0]).toMatchObject({
      name: 'helper', kind: 'function', path: 'src/util.ts', span: 'L1-L3', wholeFile: false,
    });
  });

  it('V1 reaches useA at depth 1 by calls and useB at depth 2, not useC', () => {
    const useA = report.impacted.find((i) => i.name === 'useA');
    const useB = report.impacted.find((i) => i.name === 'useB');
    expect(useA).toMatchObject({ path: 'src/a.ts', relation: 'calls', depth: 1 });
    expect(useB).toMatchObject({ path: 'src/b.ts', relation: 'calls', depth: 2 });
    expect(names(report.impacted)).not.toContain('useC');
    expect(report.impacted.every((i) => i.depth <= 2)).toBe(true);
  });

  it("V1 does not reach other's callers", () => {
    expect(names(report.impacted)).not.toContain('useOther');
    expect(report.impacted.some((i) => i.path === 'src/d.ts')).toBe(false);
  });

  it('V1 groups dependents into the src/ module, excluding hits inside the changed file', () => {
    const src = report.modules.find((m) => m.key === 'src/');
    expect(src).toBeDefined();
    expect(src!.labelSource).toBe('symbol');
    expect(src!.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(src!.files).not.toContain('src/util.ts');
    expect(src!.from).toEqual(['src/util.ts']);
    for (const m of [...report.modules, ...report.testModules]) {
      expect(m.symbols.some((s) => s.path === 'src/util.ts')).toBe(false);
    }
  });

  it('V1 splits the test file into testModules', () => {
    const testFiles = report.testModules.flatMap((m) => m.files);
    expect(testFiles).toContain('tests/util.test.ts');
    expect(report.modules.flatMap((m) => m.files)).not.toContain('tests/util.test.ts');
  });

  it('V1 marks the src/ area as reached by an unchanged test (stale)', () => {
    expect(report.areas).toHaveLength(1);
    expect(report.areas[0]).toMatchObject({
      key: 'src/', files: ['src/util.ts'], seeds: 1, behavioural: 1, reached: 1,
      tests: 'stale', testFiles: ['tests/util.test.ts'], changedTestFiles: [],
    });
  });

  it('V2 --depth all reaches useC at depth 3 and JSON prints depth as null', () => {
    const r = runBlast(root, { base: 'C1', depth: 'all', format: 'json' });
    expect(r.exitCode).toBe(0);
    const full = JSON.parse(r.output) as { depth: unknown; impacted: { name: string; depth: number }[] };
    expect(full.depth).toBeNull();
    expect(full.impacted.find((i) => i.name === 'useC')).toMatchObject({ depth: 3 });
  });

  it('V6 with no --base on a clean tree diffs the last commit', () => {
    const r = runBlast(root, { format: 'json' });
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.output) as BlastReport).basis).toBe('HEAD~1...HEAD');
  });

  it('V8 an unknown --base exits 1 with the not-in-checkout message', () => {
    const r = runBlast(root, { base: 'no-such-ref' });
    expect(r.exitCode).toBe(1);
    expect(`${r.stderr ?? ''}${r.output}`).toContain('base ref "no-such-ref" is not in this checkout.');
  });

  it('V8 --depth 0 exits 1', () => {
    expect(runBlast(root, { base: 'C1', depth: '0' }).exitCode).toBe(1);
  });

  it('V8 a non-numeric --depth exits 1', () => {
    expect(runBlast(root, { base: 'C1', depth: 'deep' }).exitCode).toBe(1);
  });

  it('V8 --format xml exits 1', () => {
    expect(runBlast(root, { base: 'C1', format: 'xml' }).exitCode).toBe(1);
  });

  it('V8 a --base with no value exits 1 instead of running the default comparison', () => {
    const r = runBlast(root, parseBlastArgv(['--base']));
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe('');
    expect(r.stderr).toBe('✗ --base needs a value');
  });

  it('V8 --base=C1 --format=json runs the C1...HEAD comparison as JSON', () => {
    const r = runBlast(root, parseBlastArgv(['--base=C1', '--format=json']));
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.output) as BlastReport).basis).toBe('C1...HEAD');
  });

  it('V8 the tool handler answers an unknown base with success-shaped text, never isError', () => {
    const res = blastToolHandler({ projectPath: root, base: 'no-such-ref' });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('base ref "no-such-ref" is not in this checkout.');
    expect('isError' in res).toBe(false);
  });

  it('V8 refExists tells a known ref from an unknown one', () => {
    expect(refExists(root, 'C1')).toBe(true);
    expect(refExists(root, 'no-such-ref')).toBe(false);
  });

  it('V9 text report first line names the basis and the depth', () => {
    const r = runBlast(root, { base: 'C1' });
    expect(r.exitCode).toBe(0);
    expect(r.output.split('\n')[0]).toBe('blast radius — C1...HEAD (depth 2)');
  });

  it('V9 text report says full closure for --depth all', () => {
    const r = runBlast(root, { base: 'C1', depth: 'all', format: 'text' });
    expect(r.exitCode).toBe(0);
    expect(r.output.split('\n')[0]).toBe('blast radius — C1...HEAD (full closure)');
  });

  it('V9 textReport on the JSON report matches runBlast text', () => {
    const r = runBlast(root, { base: 'C1' });
    const store = openBlastStore(root);
    try {
      const cs = changedFiles(root, 'C1');
      expect(cs).not.toBeNull();
      expect(textReport(blastRadius(store, cs!.files, cs!.basis, 2))).toBe(r.output);
    } finally {
      store.close();
    }
  });

  it('V9 markdown report opens with the "### blast radius" header', () => {
    const r = runBlast(root, { base: 'C1', format: 'markdown' });
    expect(r.exitCode).toBe(0);
    const lines = r.output.split('\n');
    expect(lines[0]).toBe('### blast radius');
    expect(lines).toContain('### blast radius');
  });

  it('V9 markdown report ends with the codegraph blast footer naming basis, depth and changed files', () => {
    const r = runBlast(root, { base: 'C1', format: 'markdown' });
    expect(r.exitCode).toBe(0);
    const lines = r.output.trimEnd().split('\n');
    const footer = lines[lines.length - 1];
    expect(footer.startsWith('<sub>`codegraph blast`')).toBe(true);
    expect(footer).toBe('<sub>`codegraph blast` · C1...HEAD · depth 2 · 1 changed file</sub>');
  });

  it('V9 markdown report names the seed helper and the depth-1 dependent useA', () => {
    const r = runBlast(root, { base: 'C1', format: 'markdown' });
    expect(r.exitCode).toBe(0);
    // The impact-table row: useA is the nearest hop at depth 1, reached from the helper area.
    const row = r.output.split('\n').find((l) => l.startsWith('| useA |'));
    expect(row).toBeDefined();
    expect(row).toMatch(/useA — calls, depth 1/);
    expect(row).toMatch(/\| helper \|$/);
    expect(r.output).toContain('**helper**');
  });

  it('V9 markdown report carries no mermaid diagram and no tag or owner line (ruling R5)', () => {
    const r = runBlast(root, { base: 'C1', format: 'markdown' });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain('```mermaid');
    expect(r.output.toLowerCase()).not.toContain('who to tag');
    expect(r.output).not.toMatch(/^.*\btag\b.*$/im);
    expect(r.output.toLowerCase()).not.toMatch(/\bowners?\b/);
  });

  it('V10 the walk queries incoming edges once per depth level, not per node', () => {
    const store = openBlastStore(root);
    try {
      const cs = changedFiles(root, 'C1');
      expect(cs).not.toBeNull();
      const spy = vi.spyOn(store, 'incomingEdges');
      const depth = 2;
      const r = blastRadius(store, cs!.files, cs!.basis, depth);
      expect(r.impacted.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.length).toBeLessThanOrEqual(depth * cs!.files.length);
    } finally {
      store.close();
    }
  });
});

describe('blast on repo B (method edit, top-of-file comment, deletion, added .md)', () => {
  let root = '';
  let report: BlastReport;

  beforeAll(async () => {
    root = repoAtC1('cg-blast-b-');
    write(root, 'src/cache.ts', C1_FILES['src/cache.ts'].replace('return 1;', 'return 7;'));
    write(root, 'src/b.ts', `// a note above the imports\n${C1_FILES['src/b.ts']}`);
    fs.rmSync(path.join(root, 'lib/standalone.ts'));
    write(root, 'README.md', '# fixture\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C2: method, comment, delete, readme');
    await index(root);
    const r = runBlast(root, { base: 'C1', format: 'json' });
    expect(r.exitCode).toBe(0);
    report = JSON.parse(r.output) as BlastReport;
  }, 30_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('V3 an edit inside a class method seeds the method, not the class', () => {
    const cacheSeeds = report.seeds.filter((s) => s.path === 'src/cache.ts');
    expect(cacheSeeds).toHaveLength(1);
    expect(cacheSeeds[0]).toMatchObject({ name: 'get', kind: 'method', span: 'L2-L4', wholeFile: false });
    expect(names(report.seeds)).not.toContain('Cache');
  });

  it('V4 a change outside any symbol seeds the file node as wholeFile', () => {
    const bSeeds = report.seeds.filter((s) => s.path === 'src/b.ts');
    expect(bSeeds).toHaveLength(1);
    expect(bSeeds[0]).toMatchObject({ kind: 'file', wholeFile: true });
  });

  it('V4 the file seed reaches its importers through imports edges', () => {
    const fromC = report.impacted.filter((i) => i.path === 'src/c.ts');
    expect(fromC.some((i) => i.relation === 'imports' && i.depth === 1)).toBe(true);
    // useB is in the changed file but was not edited, so it is not a seed.
    expect(names(report.seeds)).not.toContain('useB');
  });

  it('V5 a deleted file is reported as deleted, not seeded', () => {
    expect(report.deleted).toEqual(['lib/standalone.ts']);
    expect(report.seeds.some((s) => s.path === 'lib/standalone.ts')).toBe(false);
  });

  it('V5 an added file no parser claims is reported as unindexed', () => {
    expect(report.unindexed).toEqual(['README.md']);
    expect(report.seeds.some((s) => s.path === 'README.md')).toBe(false);
  });
});

describe('V6 working-tree basis (git only, no index)', () => {
  let root = '';

  beforeAll(() => {
    root = repoAtC1('cg-blast-v6-');
    write(root, 'src/util.ts', C1_FILES['src/util.ts'].replace('return 2;', 'return 3;'));
    git(root, 'commit', '-q', '-am', 'C2');
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('V6 a clean tree falls back to HEAD~1...HEAD', () => {
    const cs = changedFiles(root);
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('HEAD~1...HEAD');
    expect(cs!.files.map((f) => f.path)).toEqual(['src/util.ts']);
    expect(cs!.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
  });

  // Runs after the clean-tree test above: it dirties the shared repo.
  it('V6 a dirty tree diffs the working tree against HEAD', () => {
    write(root, 'src/a.ts', `${C1_FILES['src/a.ts']}// trailing note\n`);
    const cs = changedFiles(root);
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('working tree vs HEAD');
    expect(cs!.files.map((f) => [f.path, f.status])).toEqual([['src/a.ts', 'modified']]);
    expect(cs!.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
  });

  it('V6 --base B diffs B against the working tree, labelled plus uncommitted changes when the tree is dirty', () => {
    // Dirtied here, so the test does not depend on the dirty-tree test above having run first.
    write(root, 'src/a.ts', `${C1_FILES['src/a.ts']}// trailing note\n`);
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD plus uncommitted changes');
    expect(cs!.files.map((f) => [f.path, f.ranges])).toEqual([
      ['src/a.ts', [{ start: 6, end: 6 }]],
      ['src/util.ts', [{ start: 6, end: 6 }]],
    ]);
  });

  it('V8 runBlast with no index exits 1 and the handler returns guidance, not isError', () => {
    const r = runBlast(root, { base: 'C1' });
    expect(r.exitCode).toBe(1);
    expect(`${r.stderr ?? ''}${r.output}`).toContain(`no CodeGraph index at ${root}`);
    const res = blastToolHandler({ projectPath: root, base: 'C1' });
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toContain('no CodeGraph index at');
    expect('isError' in res).toBe(false);
  });

  it('V8 changedFiles returns null outside a git repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-nogit-'));
    try {
      expect(changedFiles(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('V8 parseBlastArgv', () => {
  it('reads the long flags', () => {
    const args = parseBlastArgv(['--base', 'main', '--depth', 'all', '--format', 'json']);
    expect(args.base).toBe('main');
    expect(String(args.depth)).toBe('all');
    expect(args.format).toBe('json');
  });

  it('reads the short flags', () => {
    const args = parseBlastArgv(['-b', 'origin/main', '-d', '3', '-f', 'markdown']);
    expect(args.base).toBe('origin/main');
    expect(String(args.depth)).toBe('3');
    expect(args.format).toBe('markdown');
  });

  it('leaves unset flags undefined', () => {
    expect(parseBlastArgv([])).toEqual({});
  });

  it('reads the flag=value form of the long flags', () => {
    expect(parseBlastArgv(['--base=origin/main']).base).toBe('origin/main');
    expect(String(parseBlastArgv(['--depth=all']).depth)).toBe('all');
    expect(parseBlastArgv(['--format=json']).format).toBe('json');
    expect(parseBlastArgv(['--base=origin/main', '--depth=3', '--format=markdown'])).toEqual(
      { base: 'origin/main', depth: '3', format: 'markdown' },
    );
  });

  it('splits flag=value at the first "=" only', () => {
    expect(parseBlastArgv(['--base=a=b']).base).toBe('a=b');
  });

  it('sets error for a flag that is the last token', () => {
    expect(parseBlastArgv(['--base']).error).toBe('✗ --base needs a value');
    expect(parseBlastArgv(['-d', '3', '--format']).error).toBe('✗ --format needs a value');
  });

  it('sets error for a flag followed by another known flag, and does not swallow it', () => {
    const args = parseBlastArgv(['--base', '--depth', '3']);
    expect(args.error).toBe('✗ --base needs a value');
    expect(args.base).toBeUndefined();
    expect(parseBlastArgv(['-b', '--format=json']).error).toBe('✗ -b needs a value');
  });

  it('sets error for an empty flag= value', () => {
    expect(parseBlastArgv(['--depth=']).error).toBe('✗ --depth needs a value');
  });

  it('takes a dash-led token that is not a known flag as the value, for runBlast to reject', () => {
    const args = parseBlastArgv(['--depth', '-1']);
    expect(args.error).toBeUndefined();
    expect(args.depth).toBe('-1');
  });

  it('ignores tokens that name Object.prototype members', () => {
    expect(parseBlastArgv(['toString', 'constructor', '--base', 'constructor'])).toEqual({ base: 'constructor' });
  });
});

describe('markdownReport collapsed symbol list', () => {
  /** A report with one module of `n` dependents of src/x.ts, and nothing else. */
  function reportWith(n: number): BlastReport {
    const symbols = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`, name: `dep${i}`, kind: 'function', path: 'lib/y.ts', span: `L${i + 1}-L${i + 1}`,
      relation: 'calls', depth: 1,
    }));
    return {
      basis: 'C1...HEAD', depth: 2,
      changed: [{ path: 'src/x.ts', status: 'modified', ranges: [{ start: 1, end: 1 }] }] as BlastReport['changed'],
      unindexed: [], deleted: [], seeds: [], impacted: symbols,
      modules: [{ label: 'lib', labelSource: 'symbol', key: 'lib/', files: ['lib/y.ts'], symbols, from: ['src/x.ts'] }],
      testModules: [], areas: [],
    };
  }

  const rows = (md: string): string[] => md.split('\n').filter((l) => l.startsWith('- `lib/y.ts:'));

  it('with 61 dependents lists 60 and says 1 further symbol is not listed', () => {
    const md = markdownReport(reportWith(61));
    expect(rows(md)).toHaveLength(60);
    expect(md).toContain('…1 further symbol not listed.');
  });

  it('with exactly 60 dependents lists all 60 and prints no further-symbols line', () => {
    const md = markdownReport(reportWith(60));
    expect(rows(md)).toHaveLength(60);
    expect(md).not.toContain('further symbol');
  });
});
