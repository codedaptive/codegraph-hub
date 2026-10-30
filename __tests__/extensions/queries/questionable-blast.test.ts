/**
 * Questionable marks and `--strict` for `codegraph blast`.
 *
 * A dependent the normal walk reaches only through a questionable call edge
 * (`src/extensions/queries/shared/questionable.ts`: a `calls` edge bound by
 * name only) carries `questionable: true`; `--strict` (CLI) / `strict: true`
 * (MCP) leaves those edges out of the walk, so the dependent is absent and the
 * JSON report carries top-level `strict: true`.
 *
 * Entry points are the ones blast-extension.test.ts uses in-process: the
 * zone's default export registered with `registerExtension` and driven
 * through `ToolHandler` for MCP, and the same export's `registerCommands` on a
 * fresh commander program for the CLI (in-process rather than the built
 * binary, so the gate does not depend on a rebuilt dist/).
 *
 * Fixture: target.ts holds `target` and `localCaller` (a same-file call, which
 * the TypeScript resolver binds as resolvedBy 'exact-match' — questionable);
 * other.ts imports `target` into `importer` (resolvedBy 'import' — certain).
 * outer.ts imports `localCaller` into `outer` (certain), so `outer` is reached
 * at depth 2 only through the questionable hop. The text and markdown module
 * lists leave out dependents inside changed files (localCaller is in the
 * changed target.ts), so those surfaces are checked on `outer`.
 * C1 is tagged, C2 edits only target()'s body, so the diff seeds `target`
 * alone. Indexing three small files is cheap, so it is built once in beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { CodeGraph } from '../../../src';
import { ToolHandler } from '../../../src/mcp/tools';
import { __resetExtensionsForTests, registerExtension } from '../../../src/extensions/host/registry';
import queriesExtension from '../../../src/extensions/queries/extension';
import { parseBlastArgv } from '../../../src/extensions/queries/blast/index';

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

const TARGET =
  'export function target(): number {\n  return 1;\n}\n\n' +
  'export function localCaller(): number {\n  return target();\n}\n';
const OUTER = "import { localCaller } from './target';\n\nexport function outer(): number {\n  return localCaller();\n}\n";
const OTHER = "import { target } from './target';\n\nexport function importer(): number {\n  return target();\n}\n";

interface ImpactedJson { name: string; questionable?: unknown; [k: string]: unknown }
interface ReportJson { impacted: ImpactedJson[]; strict?: unknown; [k: string]: unknown }

let repo = '';

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-questionable-')));
  git(repo, 'init', '-q');
  write(repo, 'src/target.ts', TARGET);
  write(repo, 'src/other.ts', OTHER);
  write(repo, 'src/outer.ts', OUTER);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C1');
  git(repo, 'tag', 'C1');
  write(repo, 'src/target.ts', TARGET.replace('return 1;', 'return 42;'));
  git(repo, 'commit', '-q', '-am', 'C2: target body');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
}, 30_000);

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

const byName = (r: ReportJson, name: string) => r.impacted.find((s) => s.name === name);

describe('fixture premise', () => {
  it('indexes localCaller→target as exact-match, importer→target and outer→localCaller as import', () => {
    // require, not import: vite cannot resolve the node:sqlite builtin (as in absent-member-calls.test.ts).
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path.join(repo, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT s.name AS caller, json_extract(e.metadata, '$.resolvedBy') AS by
           FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE e.kind = 'calls' AND t.name IN ('target', 'localCaller')`,
      ).all() as Array<{ caller: string; by: string | null }>;
      const by = Object.fromEntries(rows.map((r) => [r.caller, r.by]));
      expect(by.localCaller).toBe('exact-match');
      expect(by.importer).toBe('import');
      expect(by.outer).toBe('import');
    } finally {
      db.close();
    }
  });
});

describe('parseBlastArgv --strict', () => {
  it('sets strict: true for --strict and leaves the key absent without it', () => {
    expect(parseBlastArgv(['--base', 'C1', '--strict'])).toEqual({ base: 'C1', strict: true });
    expect('strict' in parseBlastArgv(['--base', 'C1'])).toBe(false);
  });
});

describe('codegraph_blast questionable marks (MCP, in-process)', () => {
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,blast');
    registerExtension(queriesExtension);
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  async function call(args: Record<string, unknown>) {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_blast', { projectPath: repo, base: 'C1', ...args });
    expect(res.isError).toBeFalsy();
    return res.content[0].text;
  }

  it('json: localCaller and outer are marked questionable, importer is not, and there is no strict key', async () => {
    const r = JSON.parse(await call({ format: 'json' })) as ReportJson;
    expect(byName(r, 'localCaller')?.questionable).toBe(true);
    expect(byName(r, 'outer')?.questionable).toBe(true);
    const importer = byName(r, 'importer');
    expect(importer).toBeDefined();
    expect(importer && 'questionable' in importer).toBe(false);
    expect('strict' in r).toBe(false);
  });

  it('text: the outer line ends [questionable], the importer line does not', async () => {
    const lines = (await call({})).split('\n');
    const local = lines.find((l) => l.includes('← outer ('));
    const imp = lines.find((l) => l.includes('← importer ('));
    expect(local).toMatch(/\[depth \d+\] \[questionable\]$/);
    expect(imp).toMatch(/\[depth \d+\]$/);
  });

  it('markdown: the outer detail line carries "questionable" after the depth', async () => {
    const text = await call({ format: 'markdown' });
    expect(text).toMatch(/— outer \([^)]*, depth \d+, questionable\)/);
    expect(text).toMatch(/— importer \([^)]*, depth \d+\)/);
  });

  it('strict: true, json: importer present, localCaller and outer absent, nothing marked, strict: true at top level', async () => {
    const r = JSON.parse(await call({ format: 'json', strict: true })) as ReportJson;
    expect(byName(r, 'importer')).toBeDefined();
    expect(byName(r, 'localCaller')).toBeUndefined();
    expect(byName(r, 'outer')).toBeUndefined();
    expect(r.impacted.some((s) => 'questionable' in s)).toBe(false);
    expect(r.strict).toBe(true);
  });

  it('strict: "yes" (not a boolean) answers with guidance, not isError', async () => {
    const text = await call({ strict: 'yes' });
    expect(text).toContain('strict must be');
  });
});

/**
 * Mixed paths: the mark is per dependent, not per route. A dependent some
 * changed file's certain walk reaches carries no mark and survives strict, even
 * when a questionable route reaches it too, from the same file or another.
 *
 * Own repo. a.ts: `aTarget` and `aLocal` (same-file call: exact-match,
 * questionable); x.ts's `xBoth` imports and calls both, so it is reached from
 * a.ts by a questionable route (aTarget ← aLocal ← xBoth) and a certain one
 * (aTarget ← xBoth). p.ts: `pTarget` and `pLocal` (exact-match); q.ts: `qTarget`;
 * y.ts's `yBoth` calls pLocal and qTarget through imports, so from p.ts it is
 * reached only through the questionable pLocal hop, from q.ts by a certain one.
 * Depth boundary: d.ts holds `dTarget` and `dNear`, which calls dTarget in
 * the same file (exact-match, questionable: 1 hop) and `h2` through an import;
 * h2.ts's `h2` calls h1.ts's `h1`, which calls `dTarget`, all through imports.
 * So dNear is reached by a 1-hop questionable route and a 3-hop certain one
 * (dTarget ← h1 ← h2 ← dNear); whether it is marked depends on the depth.
 * History: M1 (tagged), then one commit per changed body, tagged after a.ts
 * (MA), after q.ts (MQ) and after p.ts (MP), d.ts last. Bases pick the
 * changed set: M1 → a, q, p, d; MA → q, p, d (case b); MQ → p, d (the control
 * for case b; d.ts reaches nothing in a, p, q or y); MP → d alone (depth).
 */
describe('codegraph_blast mixed questionable and certain routes (MCP, in-process)', () => {
  const A = 'export function aTarget(): number {\n  return 1;\n}\n\nexport function aLocal(): number {\n  return aTarget();\n}\n';
  const X = "import { aTarget, aLocal } from './a';\n\nexport function xBoth(): number {\n  return aTarget() + aLocal();\n}\n";
  const P = 'export function pTarget(): number {\n  return 1;\n}\n\nexport function pLocal(): number {\n  return pTarget();\n}\n';
  const Q = 'export function qTarget(): number {\n  return 1;\n}\n';
  const Y = "import { pLocal } from './p';\nimport { qTarget } from './q';\n\nexport function yBoth(): number {\n  return pLocal() + qTarget();\n}\n";
  const D = "import { h2 } from './h2';\n\nexport function dTarget(): number {\n  return 1;\n}\n\n" +
    'export function dNear(): number {\n  return dTarget() + h2();\n}\n';
  const H1 = "import { dTarget } from './d';\n\nexport function h1(): number {\n  return dTarget();\n}\n";
  const H2 = "import { h1 } from './h1';\n\nexport function h2(): number {\n  return h1();\n}\n";

  let mixed = '';
  let cg: CodeGraph | null = null;

  beforeAll(async () => {
    mixed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-mixed-')));
    git(mixed, 'init', '-q');
    for (const [rel, body] of [['src/a.ts', A], ['src/x.ts', X], ['src/p.ts', P], ['src/q.ts', Q], ['src/y.ts', Y],
      ['src/d.ts', D], ['src/h1.ts', H1], ['src/h2.ts', H2]]) {
      write(mixed, rel!, body!);
    }
    git(mixed, 'add', '-A');
    git(mixed, 'commit', '-q', '-m', 'M1');
    git(mixed, 'tag', 'M1');
    for (const [rel, body, tag] of [['src/a.ts', A, 'MA'], ['src/q.ts', Q, 'MQ'], ['src/p.ts', P, 'MP'], ['src/d.ts', D, '']]) {
      write(mixed, rel!, body!.replace('return 1;', 'return 42;'));
      git(mixed, 'commit', '-q', '-am', `edit ${rel}`);
      if (tag) git(mixed, 'tag', tag);
    }
    const built = await CodeGraph.init(mixed);
    await built.indexAll();
    built.close();
  }, 30_000);

  afterAll(() => {
    if (mixed) fs.rmSync(mixed, { recursive: true, force: true });
  });

  beforeEach(() => {
    __resetExtensionsForTests();
    vi.stubEnv('CODEGRAPH_EXTENSION_MODULES', '');
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,blast');
    registerExtension(queriesExtension);
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    vi.unstubAllEnvs();
    __resetExtensionsForTests();
  });

  async function blastJson(base: string, strict?: boolean, depth?: number | string): Promise<ReportJson> {
    cg = await CodeGraph.open(mixed);
    const args: Record<string, unknown> = { projectPath: mixed, base, format: 'json' };
    if (strict !== undefined) args.strict = strict;
    if (depth !== undefined) args.depth = depth;
    const res = await new ToolHandler(cg).execute('codegraph_blast', args);
    expect(res.isError).toBeFalsy();
    const r = JSON.parse(res.content[0].text) as ReportJson;
    cg.close();
    cg = null;
    return r;
  }

  it('fixture premise: same-file calls are exact-match, the imported calls are import', () => {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path.join(mixed, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT s.name AS caller, t.name AS callee, json_extract(e.metadata, '$.resolvedBy') AS by
           FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE e.kind = 'calls'`,
      ).all() as Array<{ caller: string; callee: string; by: string | null }>;
      const by = Object.fromEntries(rows.map((r) => [`${r.caller}->${r.callee}`, r.by]));
      expect(by['aLocal->aTarget']).toBe('exact-match');
      expect(by['xBoth->aTarget']).toBe('import');
      expect(by['xBoth->aLocal']).toBe('import');
      expect(by['pLocal->pTarget']).toBe('exact-match');
      expect(by['yBoth->pLocal']).toBe('import');
      expect(by['yBoth->qTarget']).toBe('import');
      expect(by['dNear->dTarget']).toBe('exact-match');
      expect(by['h1->dTarget']).toBe('import');
      expect(by['h2->h1']).toBe('import');
      expect(by['dNear->h2']).toBe('import');
    } finally {
      db.close();
    }
  });

  it('(a) same file: xBoth, reached by a questionable and a certain route from a.ts, is unmarked and survives strict', async () => {
    const r = await blastJson('M1');
    expect(byName(r, 'aLocal')?.questionable).toBe(true); // the questionable route exists
    const x = byName(r, 'xBoth');
    expect(x).toBeDefined();
    expect(x && 'questionable' in x).toBe(false);
    const s = await blastJson('M1', true);
    expect(byName(s, 'aLocal')).toBeUndefined();
    expect(byName(s, 'xBoth')).toBeDefined();
    expect(s.strict).toBe(true);
  });

  it('(b) control: q.ts unchanged (base MQ changes p.ts and d.ts), yBoth is reached only through p.ts\'s questionable pLocal hop, so it is marked and strict drops it', async () => {
    const r = await blastJson('MQ');
    expect(byName(r, 'yBoth')?.questionable).toBe(true);
    expect(byName(await blastJson('MQ', true), 'yBoth')).toBeUndefined();
  });

  it('(b) cross file: with p.ts and q.ts changed, q.ts reaches yBoth certainly, so it is unmarked and survives strict', async () => {
    const r = await blastJson('MA');
    expect(byName(r, 'pLocal')?.questionable).toBe(true); // p.ts's route to yBoth is still questionable
    const y = byName(r, 'yBoth');
    expect(y).toBeDefined();
    expect(y && 'questionable' in y).toBe(false);
    const s = await blastJson('MA', true);
    expect(byName(s, 'yBoth')).toBeDefined();
    expect(s.strict).toBe(true);
  });

  it('(c) depth boundary: dNear is unmarked when the depth reaches its 3-hop certain route, marked when it does not', async () => {
    for (const depth of [3, 'all'] as const) {
      const r = await blastJson('MP', undefined, depth);
      const d = byName(r, 'dNear');
      expect(d, `depth ${depth}`).toBeDefined();
      expect(d && 'questionable' in d, `depth ${depth}`).toBe(false);
      expect(byName(await blastJson('MP', true, depth), 'dNear'), `strict depth ${depth}`).toBeDefined();
    }
    for (const depth of [1, 2]) {
      const r = await blastJson('MP', undefined, depth);
      expect(byName(r, 'dNear')?.questionable, `depth ${depth}`).toBe(true);
      expect(byName(await blastJson('MP', true, depth), 'dNear'), `strict depth ${depth}`).toBeUndefined();
    }
  });
});

describe('codegraph blast questionable marks (CLI, registered commander command)', () => {
  /** Run `codegraph blast <args>` through the zone's registerCommands on a fresh program; capture stdout. */
  async function cli(args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    queriesExtension.registerCommands?.(program);
    let stdout = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write);
    const savedExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(['blast', '--base', 'C1', '-p', repo, ...args], { from: 'user' });
      return { stdout, exitCode: process.exitCode as number | undefined };
    } finally {
      spy.mockRestore();
      process.exitCode = savedExit;
    }
  }

  it('--format json: localCaller and outer are marked questionable, importer is not, and there is no strict key', async () => {
    const res = await cli(['--format', 'json']);
    const r = JSON.parse(res.stdout) as ReportJson;
    expect(byName(r, 'localCaller')?.questionable).toBe(true);
    expect(byName(r, 'outer')?.questionable).toBe(true);
    const importer = byName(r, 'importer');
    expect(importer).toBeDefined();
    expect(importer && 'questionable' in importer).toBe(false);
    expect('strict' in r).toBe(false);
  });

  it('text: the outer line ends [questionable], the importer line does not', async () => {
    const lines = (await cli([])).stdout.split('\n');
    const local = lines.find((l) => l.includes('← outer ('));
    const imp = lines.find((l) => l.includes('← importer ('));
    expect(local).toMatch(/\[depth \d+\] \[questionable\]$/);
    expect(imp).toMatch(/\[depth \d+\]$/);
  });

  it('--strict --format json: importer present, localCaller and outer absent, nothing marked, strict: true at top level', async () => {
    const res = await cli(['--strict', '--format', 'json']);
    expect(res.exitCode ?? 0).toBe(0);
    const r = JSON.parse(res.stdout) as ReportJson;
    expect(byName(r, 'importer')).toBeDefined();
    expect(byName(r, 'localCaller')).toBeUndefined();
    expect(byName(r, 'outer')).toBeUndefined();
    expect(r.impacted.some((s) => 'questionable' in s)).toBe(false);
    expect(r.strict).toBe(true);
  });
});
