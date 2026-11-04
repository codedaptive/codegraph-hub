/**
 * Blast under a session focus (`serve --mcp --focus <dir>`), in process: `splitReportByFocus`,
 * the text and markdown renderers' "## Outside focus (N)" section, and `blastToolHandler`'s
 * `sessionFocus`. The over-stdio gates are in focus-grep-blast.gate.test.ts.
 *
 * The split and render tests use a hand-built report, so the module and file shapes are exact. The
 * handler tests index a small git repository: src/core/target.ts (edited, uncommitted) is called
 * from src/app/app.ts and src/lib/lib.ts, so each caller sits in its own module.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import type { BlastReport, Impacted, Module } from '../../../src/extensions/queries/blast/blast';
import { splitReportByFocus } from '../../../src/extensions/queries/blast/focus';
import { blastToolHandler, runBlast } from '../../../src/extensions/queries/blast/index';
import { jsonReport, markdownReport, textReport } from '../../../src/extensions/queries/blast/render';

function sym(name: string, file: string, questionable = false): Impacted {
  return { id: `${file}#${name}`, name, kind: 'function', path: file, span: 'L1-L3', relation: 'calls', depth: 1, ...(questionable ? { questionable: true as const } : {}) };
}

function mod(key: string, symbols: Impacted[]): Module {
  return { label: key, labelSource: 'symbol', key, files: [...new Set(symbols.map((s) => s.path))].sort(), symbols, from: ['src/core/target.ts'] };
}

/** A report whose `src` module holds dependents in src/app (inside focus `src/app`) and src/lib (outside), plus a `tools` module wholly outside. */
function mixedReport(): BlastReport {
  const src = mod('src', [sym('appCaller', 'src/app/app.ts'), sym('libCaller', 'src/lib/lib.ts', true), sym('appOther', 'src/app/app.ts'), sym('libOther', 'src/lib/more.ts')]);
  const tools = mod('tools', [sym('toolCaller', 'tools/run.ts')]);
  const modules = [src, tools];
  return {
    basis: 'working tree vs HEAD',
    depth: 2,
    changed: [{ path: 'src/core/target.ts', status: 'modified', ranges: [{ start: 2, end: 2 }], hunks: [] }],
    unindexed: [],
    deleted: [],
    seeds: [],
    impacted: modules.flatMap((m) => m.symbols),
    modules,
    testModules: [],
    areas: [],
  } as unknown as BlastReport;
}

describe('splitReportByFocus', () => {
  it('null prefixes (the focus holds the whole index) split nothing and attach an empty outsideFocus', () => {
    const report = mixedReport();
    const split = splitReportByFocus(report, null, '.');
    expect(split.modules).toBe(report.modules);
    expect(split.outsideFocus).toEqual({ dirs: '.', count: 0, modules: [] });
    expect(report.outsideFocus).toBeUndefined();
  });

  it('keeps in-focus symbols in modules and moves the rest to outsideFocus, files recomputed', () => {
    const report = mixedReport();
    const split = splitReportByFocus(report, ['src/app'], 'src/app');
    expect(split.modules.map((m) => [m.key, m.files, m.symbols.map((s) => s.name)])).toEqual([
      ['src', ['src/app/app.ts'], ['appCaller', 'appOther']],
    ]);
    const outside = split.outsideFocus;
    expect(outside?.dirs).toBe('src/app');
    expect(outside?.count).toBe(3);
    expect(outside?.modules.map((m) => [m.key, m.label, m.from, m.files, m.symbols.map((s) => s.name)])).toEqual([
      ['src', 'src', ['src/core/target.ts'], ['src/lib/lib.ts', 'src/lib/more.ts'], ['libCaller', 'libOther']],
      ['tools', 'tools', ['src/core/target.ts'], ['tools/run.ts'], ['toolCaller']],
    ]);
    // Not split: the walk's own results, tests, areas.
    expect(split.impacted).toBe(report.impacted);
    expect(split.testModules).toBe(report.testModules);
    expect(split.areas).toBe(report.areas);
  });

  it('compares whole path segments, so srcx/a.ts is not in src', () => {
    const report = mixedReport();
    report.modules = [mod('srcx', [sym('inX', 'srcx/a.ts')])];
    const split = splitReportByFocus(report, ['src'], 'src');
    expect(split.modules).toEqual([]);
    expect(split.outsideFocus?.count).toBe(1);
  });
});

describe('renderers under a focus', () => {
  const split = (): BlastReport => splitReportByFocus(mixedReport(), ['src/app'], 'src/app');

  it('text lists the in-focus dependent before "## Outside focus (3)" and the outside one after, counts in-focus only', () => {
    const text = textReport(split());
    const heading = text.indexOf('## Outside focus (3)');
    expect(heading).toBeGreaterThan(-1);
    expect(text.split('\n').filter((l) => l.startsWith('## Outside focus (')).length).toBe(1);
    expect(text.indexOf('appCaller')).toBeGreaterThan(-1);
    expect(text.indexOf('appCaller')).toBeLessThan(heading);
    expect(text.indexOf('libCaller')).toBeGreaterThan(heading);
    expect(text.indexOf('toolCaller')).toBeGreaterThan(heading);
    expect(text).toContain('impacted: 2 symbols in 1 area');
    expect(text).toContain('[questionable]');
  });

  it('markdown lists the in-focus dependent before "## Outside focus (3)" and the outside one after', () => {
    const md = markdownReport(split());
    const heading = md.indexOf('\n## Outside focus (3)\n');
    expect(heading).toBeGreaterThan(-1);
    expect(md.indexOf('appCaller')).toBeLessThan(heading);
    expect(md.indexOf('libCaller')).toBeGreaterThan(heading);
    expect(md).toContain('2 dependent symbols, depth 2.');
    expect(md).toContain('- `src/lib/lib.ts:L1-L3` — libCaller (calls, depth 1, questionable)');
    expect(md).toContain('**src** — 2 symbols in 2 files');
    expect(md).not.toContain('\n\n\n');
  });

  it('prints no section when nothing is outside the focus', () => {
    const report = mixedReport();
    report.modules = [mod('src', [sym('appCaller', 'src/app/app.ts')])];
    const only = splitReportByFocus(report, ['src/app'], 'src/app');
    expect(only.outsideFocus?.count).toBe(0);
    expect(textReport(only)).not.toContain('Outside focus');
    expect(markdownReport(only)).not.toContain('Outside focus');
  });

  it('text with every dependent outside says nothing is inside the focus, then lists them', () => {
    const text = textReport(splitReportByFocus(mixedReport(), ['elsewhere'], 'elsewhere'));
    expect(text).toContain("no indexed dependents inside this session's focus (elsewhere)");
    expect(text).not.toContain('no indexed dependents outside the changed files themselves');
    expect(text).toContain('impacted: 0 symbols in 0 areas');
    expect(text.indexOf("inside this session's focus")).toBeLessThan(text.indexOf('## Outside focus (5)'));
    expect(text.indexOf('appCaller')).toBeGreaterThan(text.indexOf('## Outside focus (5)'));
  });

  it('markdown with every dependent outside leads with the focus headline', () => {
    const md = markdownReport(splitReportByFocus(mixedReport(), ['elsewhere'], 'elsewhere'));
    expect(md).toContain("**Nothing inside this session's focus (elsewhere) depends on it.** 0 areas changed; 5 dependent symbols outside it, listed under Outside focus.");
    expect(md).not.toContain('| Can be affected |');
    expect(md).toContain('\n## Outside focus (5)\n');
  });

  it('markdown caps the outside list at its own 60 rows and counts the rest', () => {
    const many = Array.from({ length: 65 }, (_, i) => sym(`lib${i}`, 'src/lib/lib.ts'));
    const report = mixedReport();
    report.modules = [mod('src', [sym('appCaller', 'src/app/app.ts'), ...many])];
    const md = markdownReport(splitReportByFocus(report, ['src/app'], 'src/app'));
    expect(md).toContain('## Outside focus (65)');
    expect(md).toContain('…5 further symbols not listed.');
    expect(md).toContain('lib59 (');
    expect(md).not.toContain('lib60 (');
  });

  it('json carries outsideFocus on the report, and an unsplit report has no such key', () => {
    const parsed = JSON.parse(jsonReport(split())) as BlastReport;
    expect(parsed.outsideFocus?.count).toBe(3);
    expect(parsed.outsideFocus?.dirs).toBe('src/app');
    expect(jsonReport(mixedReport())).not.toContain('outsideFocus');
  });
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

describe('blastToolHandler with a session focus', () => {
  let root = '';

  beforeAll(async () => {
    // The temp dir's canonical path, so the focus directories below match what host's focusPrefixesFor resolves.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-focus-')));
    git(root, 'init', '-q');
    write(root, 'src/core/target.ts', 'export function target(): string {\n  return "v1";\n}\n');
    write(root, 'src/app/app.ts', "import { target } from '../core/target';\n\nexport function appCaller(): string {\n  return target();\n}\n");
    write(root, 'src/lib/lib.ts', "import { target } from '../core/target';\n\nexport function libCaller(): string {\n  return target();\n}\n");
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    write(root, 'src/core/target.ts', 'export function target(): string {\n  return "v2";\n}\n');
    const cg = await CodeGraph.init(root);
    await cg.indexAll();
    cg.close();
  }, 30_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const text = (res: { content: [{ type: 'text'; text: string }] }): string => res.content[0].text;

  it('an omitted or empty sessionFocus answers what the command answers, in every format', () => {
    for (const format of ['text', 'markdown', 'json']) {
      const cli = runBlast(root, { format });
      expect(cli.exitCode).toBe(0);
      expect(text(blastToolHandler({ projectPath: root, format }))).toBe(cli.output);
      expect(text(blastToolHandler({ projectPath: root, format, sessionFocus: [] }))).toBe(cli.output);
    }
    expect(runBlast(root, { format: 'json' }).output).not.toContain('outsideFocus');
  });

  it('a focus holding the whole repository answers what the command answers in text and markdown, and json carries an empty outsideFocus', () => {
    for (const format of ['text', 'markdown']) {
      const cli = runBlast(root, { format });
      expect(text(blastToolHandler({ projectPath: root, format, sessionFocus: [root] })), format).toBe(cli.output);
    }
    const json = JSON.parse(text(blastToolHandler({ projectPath: root, format: 'json', sessionFocus: [root] }))) as BlastReport;
    expect(json.outsideFocus).toEqual({ dirs: '.', count: 0, modules: [] });
    expect(json.modules.flatMap((m) => m.symbols.map((s) => s.name))).toEqual(['appCaller', 'app.ts', 'libCaller', 'lib.ts']);
    for (const sessionFocus of [[], undefined]) {
      const bare = text(blastToolHandler({ projectPath: root, format: 'json', sessionFocus }));
      expect(bare).toBe(runBlast(root, { format: 'json' }).output);
      expect(bare).not.toContain('outsideFocus');
    }
  });

  it('a focus on src/app lists the dependents of lib.ts under Outside focus in text, markdown and json', () => {
    const sessionFocus = [path.join(root, 'src/app')];
    for (const format of ['text', 'markdown'] as const) {
      const out = text(blastToolHandler({ projectPath: root, format, sessionFocus }));
      // Each caller file brings two dependents: the function (calls) and its file node (imports).
      const heading = out.indexOf('## Outside focus (2)');
      expect(heading, format).toBeGreaterThan(-1);
      expect(out.indexOf('appCaller'), format).toBeLessThan(heading);
      expect(out.indexOf('libCaller'), format).toBeGreaterThan(heading);
    }
    const report = JSON.parse(text(blastToolHandler({ projectPath: root, format: 'json', sessionFocus }))) as BlastReport;
    expect(report.modules.flatMap((m) => m.symbols.map((s) => s.name))).toEqual(['appCaller', 'app.ts']);
    expect(report.outsideFocus?.count).toBe(2);
    expect(report.outsideFocus?.dirs).toBe('src/app');
    expect(report.outsideFocus?.modules.flatMap((m) => m.symbols.map((s) => s.name))).toEqual(['libCaller', 'lib.ts']);
  });

  it('a focus on a directory with no dependent says so and still lists them all outside', () => {
    const out = text(blastToolHandler({ projectPath: root, format: 'text', sessionFocus: [path.join(root, 'docs')] }));
    expect(out).toContain("no indexed dependents inside this session's focus (docs)");
    expect(out).toContain('## Outside focus (4)');
  });
});
