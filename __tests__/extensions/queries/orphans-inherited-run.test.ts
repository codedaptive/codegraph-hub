/**
 * `codegraph orphans`: the index-currency check (O-04) and the raw search stage
 * (O-11), run through `runOrphans` and `orphansToolHandler` on real CodeGraph
 * indexes of fixture git repos. Every fixture is its own repo, built in its
 * describe's beforeAll; the runs happen there too, so each `it` only asserts.
 * A vector marked "red" failed before its fix; the file passes at HEAD.
 *
 * O-04: a changed file the index has not caught up with fails the run before any
 * symbol is counted. Vectors:
 *   (1) was red: C2 adds addedFn at lines 9-11 of src/mod.ts; an uncommitted edit
 *       prepends 4 lines and the index is synced to it, so addedFn sits at 13-15
 *       and the committed diff's 9-11 found nothing. The fix refused the run with
 *       "commit or stash"; R1-21 superseded that refusal: the diff now runs to the
 *       working tree, so the run exits 0 and lists addedFn, with the basis
 *       "C1...HEAD plus uncommitted changes".
 *   (2) red: the index is built at C1, C2 adds addedFn, and nothing syncs. The
 *       run must fail, naming the file and the index sync.
 *   (3) pin: clean tree, index at C2: exit 0 and addedFn listed.
 *   (4) pin: src/gone.ts is added in C2, indexed, then deleted from the working
 *       tree: it is not checked, exit 0.
 *   (5) pin, POSIX: a committed symlink src/out.ts to a file outside the root
 *       does not trip the check.
 *   (6) was red: the project is app/, a subdirectory of the git repo. The (1)
 *       edit then failed at a project-relative path; under R1-21 it lists addedFn,
 *       and the listed path is project-relative (src/mod.ts, not app/src/mod.ts):
 *       this is what `--relative` on the diff proves.
 *
 * O-11: the orphans search adapter calls `searchIndexText`, never `grepIndex`.
 *   (1) red: `grepIndex` is mocked (importOriginal spread) to throw while the
 *       flag is up, which only this case raises. runOrphans must still exit 0 and
 *       list addedFn as guessed, with its one mention in z/use.ts:1.
 *   (2)-(4) new API `searchIndexText`, in describes of their own. It is read
 *       through the module namespace, so a missing export fails each case at its
 *       own assertion, not at import.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { orphansToolHandler, runOrphans, type OrphansResult } from '../../../src/extensions/queries/orphans/index';
import * as grepCore from '../../../src/extensions/queries/grep/grep-core';
import { GrepPatternError, GrepScopeError, grepIndex, type GrepOptions } from '../../../src/extensions/queries/grep/grep-core';

/** Flipped on by the O-11 (1) case only: while it is up, `grepIndex` throws. */
const grepHooks = vi.hoisted(() => ({ throwGrepIndex: false }));

vi.mock('../../../src/extensions/queries/grep/grep-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extensions/queries/grep/grep-core')>();
  return {
    ...actual,
    grepIndex: (...args: Parameters<typeof actual.grepIndex>) => {
      if (grepHooks.throwGrepIndex) throw new Error('grepIndex must not run for the orphans search');
      return actual.grepIndex(...args);
    },
  };
});

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
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

/** Stage everything except CodeGraph's own folder, then commit. */
function commitAll(root: string, message: string): void {
  git(root, 'add', '-A', '--', '.', ':(exclude).codegraph');
  git(root, 'commit', '-q', '-m', message);
}

/** A git repo whose first commit holds `c1`, tagged C1. Nothing is indexed. */
function newRepo(prefix: string, c1: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(c1)) write(root, rel, content);
  commitAll(root, 'C1');
  git(root, 'tag', 'C1');
  return root;
}

async function indexAt(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

/** Bring the index up to the working tree (`codegraph sync`). */
async function syncAt(root: string): Promise<void> {
  const cg = await CodeGraph.open(root);
  await cg.sync();
  cg.close();
}

interface IndexedNode { name: string; file_path: string; start_line: number; end_line: number }

function indexedNodes(root: string, name: string): IndexedNode[] {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    return conn.getDb()
      .prepare('SELECT name, file_path, start_line, end_line FROM nodes WHERE name = ? ORDER BY file_path, start_line')
      .all(name) as unknown as IndexedNode[];
  } finally {
    conn.close();
  }
}

interface OrphansJson {
  added: number;
  orphans: { name: string }[];
  guessed: { name: string; mentions: { path: string; line: number }[] }[];
  searchUnread: number;
}

const listedNames = (r: OrphansJson): string[] => [...r.orphans, ...r.guessed].map((e) => e.name);

const BASE = 'export function base(): number {\n  return 0;\n}\n';
/** C1 of src/mod.ts: seven lines, then the blank line 8 that C2 leaves before addedFn. */
const MOD_C1 = 'export function keep(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n';
/** C2: addedFn at lines 9-11. */
const MOD_C2 = `${MOD_C1}\nexport function addedFn() {\n  return 3;\n}\n`;
/** An uncommitted edit that moves addedFn to lines 13-15. */
const PREPEND_4 = '// one\n// two\n// three\n// four\n';

// ---------------------------------------------------------------------------
// O-04: the index must match the working tree
// ---------------------------------------------------------------------------

// O-04 (1) was red before its fix (the committed diff's 9-11 missed addedFn at 13-15, and the run
// reported nothing); the fix then refused the run with "commit or stash". That refusal is superseded
// by R1-21: the diff now runs from the merge base to the working tree, so its ranges are the synced
// index's lines and the run lists addedFn.
describe('O-04 (1) an uncommitted edit under a synced index is read from the working tree (R1-21): exit 0, addedFn listed', () => {
  let root = '';
  let result: OrphansResult;
  let mcp: { text: string; isError?: boolean };

  beforeAll(async () => {
    root = newRepo('cg-oi-run-1-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    write(root, 'src/mod.ts', PREPEND_4 + MOD_C2);
    await syncAt(root);
    result = await runOrphans(root, { base: 'C1', format: 'json' });
    const res = await orphansToolHandler({ projectPath: root, base: 'C1', format: 'json' });
    mcp = { text: res.content[0].text, isError: (res as { isError?: boolean }).isError };
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('O-04 (1) fixture: the uncommitted edit is in the working tree, and the synced index puts addedFn at lines 13-15', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD')).toContain('src/mod.ts');
    expect(indexedNodes(root, 'addedFn')).toEqual([
      { name: 'addedFn', file_path: 'src/mod.ts', start_line: 13, end_line: 15 },
    ]);
  });

  it('O-04 (1) runOrphans exits 0 with stderr empty and lists addedFn', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(listedNames(JSON.parse(result.output) as OrphansJson)).toContain('addedFn');
  });

  it('O-04 (1) the report basis says the diff includes uncommitted changes', () => {
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as { basis: string }).basis).toBe('C1...HEAD plus uncommitted changes');
  });

  it('O-04 (1) orphansToolHandler returns the report as text, addedFn in it, with no isError', () => {
    expect(mcp.text).toContain('addedFn');
    expect(mcp.text).not.toMatch(/commit or stash/);
    expect(mcp.isError).toBeFalsy();
  });
});

describe('O-04 (2) red: a commit the index has not caught up with fails the run, naming the file and the sync', () => {
  let root = '';
  let result: OrphansResult;
  let mcp: { text: string; isError?: boolean };

  beforeAll(async () => {
    root = newRepo('cg-oi-run-2-', { 'src/mod.ts': MOD_C1 });
    // Indexed at C1: the index never sees C2's addedFn.
    await indexAt(root);
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn, no sync');
    result = await runOrphans(root, { base: 'C1' });
    const res = await orphansToolHandler({ projectPath: root, base: 'C1' });
    mcp = { text: res.content[0].text, isError: (res as { isError?: boolean }).isError };
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('O-04 (2) fixture: the tree is clean against HEAD, and the index is at C1 (no addedFn)', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD').trim()).toBe('');
    expect(indexedNodes(root, 'addedFn')).toEqual([]);
  });

  it('O-04 (2) runOrphans exits 1 with stderr naming src/mod.ts and the index sync', () => {
    expect(result.exitCode).toBe(1);
    expect(result.stderr ?? '').toContain('src/mod.ts');
    expect(result.stderr ?? '').toMatch(/sync/i);
  });

  it('O-04 (2) orphansToolHandler returns the same guidance as text, with no isError', () => {
    expect(mcp.text).toContain('src/mod.ts');
    expect(mcp.text).toMatch(/sync/i);
    expect(mcp.isError).toBeFalsy();
  });
});

describe('O-04 (3) pin: a clean tree and a synced index run as before', () => {
  let root = '';
  let result: OrphansResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-run-3-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    result = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('O-04 (3) exits 0 with stderr empty', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('O-04 (3) lists addedFn, one symbol added', () => {
    const report = JSON.parse(result.output) as OrphansJson;
    expect(report.added).toBe(1);
    expect(listedNames(report)).toContain('addedFn');
  });
});

describe('O-04 (4) pin: a file deleted from the working tree after indexing is not checked', () => {
  let root = '';
  let result: OrphansResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-run-4-', { 'src/base.ts': BASE });
    write(root, 'src/gone.ts', 'export function gone(): number {\n  return 4;\n}\n');
    commitAll(root, 'C2: add gone.ts');
    await indexAt(root);
    fs.rmSync(path.join(root, 'src', 'gone.ts'));
    result = await runOrphans(root, { base: 'C1' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('O-04 (4) fixture: gone is still indexed, and its file is gone from the working tree', () => {
    expect(indexedNodes(root, 'gone')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'src', 'gone.ts'))).toBe(false);
  });

  it('O-04 (4) exits 0 with stderr empty: a deleted path is neither read nor compared', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
  });
});

describe.runIf(process.platform !== 'win32')('O-04 (5) pin: a committed symlink out of the root does not trip the check', () => {
  let root = '';
  let outside = '';
  let result: OrphansResult;

  beforeAll(async () => {
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-run-5-outside-')));
    fs.writeFileSync(path.join(outside, 'out.ts'), 'export function outsideFn(): number {\n  return 5;\n}\n');
    root = newRepo('cg-oi-run-5-', { 'src/base.ts': BASE });
    write(root, 'src/mod.ts', MOD_C2);
    fs.symlinkSync(path.join(outside, 'out.ts'), path.join(root, 'src', 'out.ts'));
    commitAll(root, 'C2: add addedFn and a symlink out of the root');
    await indexAt(root);
    result = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    for (const d of [root, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('O-04 (5) fixture: src/out.ts is a committed symlink out of the root, and the indexer reads outsideFn through it', () => {
    expect(fs.lstatSync(path.join(root, 'src', 'out.ts')).isSymbolicLink()).toBe(true);
    expect(indexedNodes(root, 'outsideFn').map((n) => n.file_path)).toEqual(['src/out.ts']);
  });

  it('O-04 (5) exits 0 with stderr empty and addedFn listed', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(listedNames(JSON.parse(result.output) as OrphansJson)).toContain('addedFn');
  });
});

// O-04 (6) was red before its fix, then pinned the "commit or stash" refusal at a project-relative
// path. Superseded by R1-21 like (1): the edit is read from the working tree, and what stays pinned is
// that the listed entry's path is relative to the project (`--relative`), not to the git repo.
describe('O-04 (6) with the project in a subdirectory of the git repo, the (1) edit lists addedFn at its project-relative path', () => {
  let repo = '';
  let app = '';
  let result: OrphansResult;

  beforeAll(async () => {
    repo = newRepo('cg-oi-run-6-', { 'app/src/mod.ts': MOD_C1, 'outside/readme.txt': 'not code\n' });
    write(repo, 'app/src/mod.ts', MOD_C2);
    commitAll(repo, 'C2: add addedFn under app/');
    app = path.join(repo, 'app');
    await indexAt(app);
    write(repo, 'app/src/mod.ts', PREPEND_4 + MOD_C2);
    await syncAt(app);
    result = await runOrphans(app, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('O-04 (6) fixture: the project index at app/ places addedFn at lines 13-15 in src/mod.ts', () => {
    expect(indexedNodes(app, 'addedFn')).toEqual([
      { name: 'addedFn', file_path: 'src/mod.ts', start_line: 13, end_line: 15 },
    ]);
  });

  it('O-04 (6) runOrphans on app/ exits 0 with stderr empty and lists addedFn', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(listedNames(JSON.parse(result.output) as OrphansJson)).toContain('addedFn');
  });

  it('O-04 (6) the listed addedFn path is relative to the project, not the git repo', () => {
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as { orphans: { name: string; path: string }[]; guessed: { name: string; path: string }[] };
    const entry = [...report.orphans, ...report.guessed].find((e) => e.name === 'addedFn');
    expect(entry?.path).toBe('src/mod.ts');
  });
});

// ---------------------------------------------------------------------------
// O-11: the orphans search adapter calls searchIndexText, never grepIndex
// ---------------------------------------------------------------------------

describe('O-11 (1) red: the orphans search does not call grepIndex', () => {
  let root = '';
  let result: OrphansResult;

  beforeAll(async () => {
    root = newRepo('cg-oi-run-11-', {
      'src/base.ts': BASE,
      'z/use.ts': '// addedFn is wired by name at runtime\nexport const USE = 1;\n',
    });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    grepHooks.throwGrepIndex = true;
    try {
      result = await runOrphans(root, { base: 'C1', format: 'json' }).catch((e: unknown): OrphansResult => ({
        output: '',
        exitCode: -1,
        stderr: `runOrphans threw: ${(e as Error).message}`,
      }));
    } finally {
      grepHooks.throwGrepIndex = false;
    }
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('O-11 (1) fixture: addedFn is indexed in src/mod.ts, and z/use.ts is indexed too', () => {
    expect(indexedNodes(root, 'addedFn').map((n) => n.file_path)).toEqual(['src/mod.ts']);
    expect(fs.readFileSync(path.join(root, 'z', 'use.ts'), 'utf8')).toContain('addedFn');
  });

  it('O-11 (1) with grepIndex throwing, runOrphans exits 0 with stderr empty', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('O-11 (1) lists addedFn as guessed, with its mention at z/use.ts:1', () => {
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as OrphansJson;
    expect(report.guessed.find((g) => g.name === 'addedFn')?.mentions).toEqual([{ path: 'z/use.ts', line: 1 }]);
  });
});

// The new API, read through the namespace: a missing export fails at the case's own assertion.
type Hit = { path: string; line: number; text: string };
interface RawSearchResult {
  pattern: string;
  filesSearched: number;
  hits: Hit[];
  truncated: { files: number; hits: number };
}
type SearchIndexText = (projectRoot: string, pattern: string, opts?: GrepOptions) => Promise<RawSearchResult>;

function searchIndexTextApi(): SearchIndexText {
  // `in` rather than a property read: the vi.mock module proxy throws on a read of a name it does not define.
  if (!('searchIndexText' in grepCore)) throw new Error('grep-core does not export searchIndexText yet');
  return (grepCore as unknown as { searchIndexText: SearchIndexText }).searchIndexText;
}

const collator = new Intl.Collator();
const byPathThenLine = (a: Hit, b: Hit): number => collator.compare(a.path, b.path) || a.line - b.line;
const sortHits = (hits: Hit[]): Hit[] => [...hits].sort(byPathThenLine);

/** The hits of a grepIndex result, flattened out of their symbol groups. */
function flattenGroups(r: Awaited<ReturnType<typeof grepIndex>>): Hit[] {
  return r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text })));
}

/** The error a run throws, as the parts the two engines must agree on; null when it returns. */
async function errorOf(run: () => Promise<unknown>): Promise<{ ctor: string; message: string; reason?: string } | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as Error & { reason?: string };
    return { ctor: err.constructor.name, message: err.message, reason: err.reason };
  }
}

describe('O-11 searchIndexText, the raw search stage (new API)', () => {
  let root = '';
  let unindexed = '';
  let toolsDir = '';

  beforeAll(async () => {
    root = newRepo('cg-oi-run-search-', {
      'src/a.ts': 'export const a1 = "TOKEN";\nexport const a2 = "TOKEN";\n',
      'src/ab.ts': 'export const b1 = "TOKEN";\nexport const b2 = "TOKEN";\n',
      'src/b.ts': 'export function bf(): string {\n  return "TOKEN";\n  // TOKEN again\n}\n',
      'gone.ts': 'export const gone = "TOKEN";\n',
    });
    await indexAt(root);
    // Still in the index, no longer readable: the search counts it as unread.
    fs.rmSync(path.join(root, 'gone.ts'));
    unindexed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-run-search-none-')));
    toolsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oi-run-search-tools-')));
  }, 60_000);

  afterAll(() => {
    for (const d of [root, unindexed, toolsDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A ripgrep stand-in that prints something that is not JSON. */
  function fakeRg(): string {
    const p = path.join(toolsDir, 'fake-rg.sh');
    fs.writeFileSync(p, '#!/bin/sh\necho -x\nexit 0\n', { mode: 0o755 });
    return p;
  }

  it('O-11 (2) fixture: grepIndex finds six TOKEN lines in four indexed files, one of them unreadable', async () => {
    const r = await grepIndex(root, 'TOKEN');
    expect(flattenGroups(r)).toHaveLength(6);
    expect(r.filesSearched).toBe(4);
    expect(r.truncated).toEqual({ files: 1, hits: 0 });
  });

  it('O-11 (2) searchIndexText hits are grepIndex hits flattened and sorted by path then line, with the same cap and unread counts', async () => {
    const grep = await grepIndex(root, 'TOKEN', { maxHits: 3 });
    const raw = await searchIndexTextApi()(root, 'TOKEN', { maxHits: 3 });
    expect(raw.pattern).toBe('TOKEN');
    expect(raw.filesSearched).toBe(grep.filesSearched);
    expect(raw.truncated).toEqual(grep.truncated);
    expect(raw.truncated).toEqual({ files: 1, hits: 3 });
    expect(raw.hits).toHaveLength(3);
    // grep R2-06 added an optional match `column` to each raw hit, which grepIndex's groups do not carry:
    // compare the parts both have, and require the column on every raw hit (rg reports one for each match).
    for (const h of raw.hits) expect(typeof (h as Hit & { column?: unknown }).column).toBe('number');
    const projected = raw.hits.map(({ path: p, line, text }) => ({ path: p, line, text }));
    expect(sortHits(projected)).toEqual(sortHits(flattenGroups(grep)));
  });

  it('O-11 (2) the hits come back already in (path rank, line) order', async () => {
    const raw = await searchIndexTextApi()(root, 'TOKEN', { maxHits: 3 });
    expect(raw.hits).toEqual(sortHits(raw.hits));
  });

  describe('O-11 (3) one DatabaseConnection close per call, grepIndex and searchIndexText alike', () => {
    afterEach(() => vi.restoreAllMocks());

    // The mechanism of grep-by-symbol's "DB closed on every path": spy on the prototype's close and count.
    const closes = async (run: () => Promise<unknown>): Promise<number> => {
      const spy = vi.spyOn(DatabaseConnection.prototype, 'close');
      await run().catch(() => undefined);
      return spy.mock.calls.length;
    };

    const engines: [string, (r: string, p: string, o?: GrepOptions) => Promise<unknown>][] = [
      ['grepIndex', (r, p, o) => grepIndex(r, p, o)],
      ['searchIndexText', (r, p, o) => searchIndexTextApi()(r, p, o)],
    ];

    for (const [name, engine] of engines) {
      it(`O-11 (3) ${name}: success closes the database once`, async () => {
        expect(await closes(() => engine(root, 'TOKEN'))).toBe(1);
      });

      it(`O-11 (3) ${name}: GrepScopeError closes the database once`, async () => {
        await expect(engine(root, 'TOKEN', { in: 'src/nope' })).rejects.toBeInstanceOf(GrepScopeError);
        expect(await closes(() => engine(root, 'TOKEN', { in: 'src/nope' }))).toBe(1);
      });

      it(`O-11 (3) ${name}: a pattern JS accepts and rg refuses (lookbehind) closes the database once`, async () => {
        await expect(engine(root, '(?<=a)b')).rejects.toBeInstanceOf(GrepPatternError);
        expect(await closes(() => engine(root, '(?<=a)b'))).toBe(1);
      });

      it.runIf(process.platform !== 'win32')(`O-11 (3) ${name}: malformed rg output closes the database once`, async () => {
        expect(await closes(() => engine(root, 'TOKEN', { rgPath: fakeRg() }))).toBe(1);
      });
    }
  });

  describe('O-11 (4) searchIndexText fails the way grepIndex does', () => {
    async function sameError(
      grepRun: () => Promise<unknown>,
      searchRun: () => Promise<unknown>,
      ctor: string,
    ): Promise<void> {
      const want = await errorOf(grepRun);
      expect(want?.ctor).toBe(ctor);
      expect(await errorOf(searchRun)).toEqual(want);
    }

    it('O-11 (4) no index: the same GrepIndexError (not-indexed)', async () => {
      const want = await errorOf(() => grepIndex(unindexed, 'TOKEN'));
      expect(want).toMatchObject({ ctor: 'GrepIndexError', reason: 'not-indexed' });
      expect(await errorOf(() => searchIndexTextApi()(unindexed, 'TOKEN'))).toEqual(want);
    });

    it('O-11 (4) a bad regex: the same GrepPatternError', async () => {
      await sameError(
        () => grepIndex(root, '('),
        () => searchIndexTextApi()(root, '('),
        'GrepPatternError',
      );
    });

    it('O-11 (4) maxHits -1: the same TypeError', async () => {
      await sameError(
        () => grepIndex(root, 'TOKEN', { maxHits: -1 }),
        () => searchIndexTextApi()(root, 'TOKEN', { maxHits: -1 }),
        'TypeError',
      );
      expect(await errorOf(() => searchIndexTextApi()(root, 'TOKEN', { maxHits: -1 }))).toMatchObject({
        message: 'maxHits must be a non-negative integer, got -1',
      });
    });

    it('O-11 (4) an in prefix with nothing indexed under it: the same GrepScopeError', async () => {
      await sameError(
        () => grepIndex(root, 'TOKEN', { in: 'src/nope' }),
        () => searchIndexTextApi()(root, 'TOKEN', { in: 'src/nope' }),
        'GrepScopeError',
      );
    });
  });
});
