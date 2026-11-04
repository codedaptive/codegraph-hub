/**
 * orphans-review-fixes, unit B (the orphans runner): `runOrphans` and
 * `orphansToolHandler` on real CodeGraph indexes of fixture git repos.
 *
 * SF-03: a modified or renamed file whose changed lines git could not read (the
 *   patch pass failed, `hasUnreadRanges`) fails the run: an empty report would
 *   read as "nothing added" when no added symbol was checked. The published
 *   runner (src/graph/orphans-run.ts:68-74) refuses with "git could not read the
 *   changed lines of the diff ... so no added symbol was checked". Controls: an
 *   added file needs no ranges, so with the pass failing its function is still
 *   listed; a .ts file git diffs as binary (`-diff`) has no hunks but its patch
 *   pass succeeded, so it is not refused and O-10's whole-file fallback still
 *   finds the new name.
 *   A failed patch pass is a vi.mock of the zone's git runner that wraps the real
 *   one and fails only the `--unified=0` call while `gitFault.failPatch` is on, as
 *   blast-review-fixes-diff.test.ts does.
 *
 * R1-21 consumption: `changedFiles` now diffs the merge base against the working
 *   tree, so an uncommitted edit under a synced index is part of the diff and its
 *   new function is listed (exit 0, basis `C1...HEAD plus uncommitted changes`).
 *   The same edit with the index not synced still fails with the "index has not
 *   caught up" guidance. `checkIndexCurrency` is asserted through
 *   `currencyFailure` only, so the test compiles whatever lists the result holds.
 *
 * R1-26 (path half): `mentionSearchBatchBytes(platform)` from index.ts is 8 KiB on
 *   win32 and undefined elsewhere (grep's own default). On win32 the mention
 *   pattern budget (`mentionPatternBytes('win32')`, unit A, orphans.ts) plus this
 *   plus 1 KiB of fixed arguments stays under the 32,767-unit command line. The
 *   runner passes it to `searchIndexText` as `batchBytes`: `process.platform` is
 *   stubbed to 'win32' around one run (restored in afterEach), and the search is
 *   replaced by a recorder returning no hits (so no rg runs under the stub).
 *   New exports are read through the module namespace with `in`, so a missing one
 *   fails at an assertion rather than at import.
 *
 * Every beforeAll builds and indexes a fixture repo; indexing is why those hooks
 * take more than 5 seconds on a loaded machine (60 s timeouts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import * as orphansIndex from '../../../src/extensions/queries/orphans/index';
import { orphansToolHandler, runOrphans, type OrphansResult } from '../../../src/extensions/queries/orphans/index';
import * as orphansCore from '../../../src/extensions/queries/orphans/orphans';
import { checkIndexCurrency, currencyFailure } from '../../../src/extensions/queries/orphans/freshness';
import type { GrepOptions } from '../../../src/extensions/queries/grep/grep-core';

/** `failPatch` makes the patch pass (`git diff --unified=0`) read as a git failure; `hits` counts those calls. */
const gitFault = vi.hoisted(() => ({ failPatch: false, hits: 0 }));

vi.mock('../../../src/extensions/queries/shared/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extensions/queries/shared/git')>();
  return {
    ...actual,
    git: (root: string, args: string[]) => {
      if (gitFault.failPatch && args.includes('--unified=0')) {
        gitFault.hits += 1;
        return null;
      }
      return actual.git(root, args);
    },
  };
});

/** While `record` is on, `searchIndexText` records its options and returns no hits without running rg. */
const searchHooks = vi.hoisted(() => ({ record: false, calls: [] as (GrepOptions | undefined)[] }));

vi.mock('../../../src/extensions/queries/grep/grep-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extensions/queries/grep/grep-core')>();
  return {
    ...actual,
    searchIndexText: (...args: Parameters<typeof actual.searchIndexText>) => {
      if (!searchHooks.record) return actual.searchIndexText(...args);
      const [, pattern, opts] = args;
      searchHooks.calls.push(opts);
      return Promise.resolve({ pattern, filesSearched: 0, hits: [], truncated: { files: 0, hits: 0 } });
    },
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  gitFault.failPatch = false;
  gitFault.hits = 0;
  searchHooks.record = false;
  searchHooks.calls = [];
  Object.defineProperty(process, 'platform', realPlatform);
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

interface OrphansJson {
  basis: string;
  added: number;
  orphans: { name: string; path: string }[];
  guessed: { name: string; path: string }[];
}

const listedNames = (r: OrphansJson): string[] => [...r.orphans, ...r.guessed].map((e) => e.name);

/** The JSON report of a run, or a fixed empty report when the run failed (its assertions then fail on the names). */
function reportOf(r: OrphansResult): OrphansJson {
  if (r.exitCode !== 0) return { basis: '', added: 0, orphans: [], guessed: [] };
  return JSON.parse(r.output) as OrphansJson;
}

const STABLE = 'export function stable(): number {\n  return 1;\n}\n';
const LONELY_NEW = '\nexport function lonelyNew(): number {\n  return 5;\n}\n';
/** Enough unchanged lines that git still pairs the rename with an appended function. */
const RENAME_BODY = Array.from({ length: 12 }, (_, i) => `export function keep${i}(): number {\n  return ${i};\n}\n`).join('');
const UNREAD_PHRASE = /could not read the changed lines/;

// ---------------------------------------------------------------------------
// SF-03: a modified or renamed file with unread ranges fails the run
// ---------------------------------------------------------------------------

describe('SF-03: a modified file whose changed lines git could not read fails the run', () => {
  let root = '';
  let control: OrphansResult;
  let failed: OrphansResult;
  let failedHits = 0;
  let mcp: { text: string; isError?: boolean };

  beforeAll(async () => {
    root = newRepo('cg-orf-sf03-mod-', { 'src/existing.ts': STABLE });
    write(root, 'src/existing.ts', STABLE + LONELY_NEW);
    commitAll(root, 'C2: add lonelyNew to an existing file');
    await indexAt(root);
    control = await runOrphans(root, { base: 'C1', format: 'json' });
    gitFault.failPatch = true;
    try {
      failed = await runOrphans(root, { base: 'C1', format: 'json' });
      failedHits = gitFault.hits;
      const res = await orphansToolHandler({ projectPath: root, base: 'C1' });
      mcp = { text: res.content[0].text, isError: (res as { isError?: boolean }).isError };
    } finally {
      gitFault.failPatch = false;
    }
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('SF-03 control: with the patch pass reading, runOrphans exits 0 and lists lonelyNew', () => {
    expect(control.stderr ?? '').toBe('');
    expect(control.exitCode).toBe(0);
    expect(listedNames(reportOf(control))).toContain('lonelyNew');
  });

  it('SF-03 fixture: the failing run reached the patch pass', () => {
    expect(failedHits).toBeGreaterThan(0);
  });

  it('SF-03 runOrphans exits 1, stderr saying git could not read the changed lines and no added symbol was checked', () => {
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr ?? '').toMatch(UNREAD_PHRASE);
    expect(failed.stderr ?? '').toMatch(/no added symbol/);
  });

  it('SF-03 orphansToolHandler returns the same refusal as text, with no isError', () => {
    expect(mcp.text).toMatch(UNREAD_PHRASE);
    expect(mcp.isError).toBeFalsy();
  });
});

describe('SF-03: a renamed file whose changed lines git could not read fails the run', () => {
  let root = '';
  let control: OrphansResult;
  let failed: OrphansResult;
  let statuses: string;

  beforeAll(async () => {
    root = newRepo('cg-orf-sf03-ren-', { 'src/old-name.ts': RENAME_BODY });
    fs.rmSync(path.join(root, 'src', 'old-name.ts'));
    write(root, 'src/new-name.ts', RENAME_BODY + LONELY_NEW);
    commitAll(root, 'C2: rename and add lonelyNew');
    statuses = git(root, 'diff', '--name-status', '--find-renames', 'C1', 'HEAD');
    await indexAt(root);
    control = await runOrphans(root, { base: 'C1', format: 'json' });
    gitFault.failPatch = true;
    try {
      failed = await runOrphans(root, { base: 'C1', format: 'json' });
    } finally {
      gitFault.failPatch = false;
    }
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('SF-03 fixture: git reads the change as a rename of src/old-name.ts to src/new-name.ts', () => {
    expect(statuses).toMatch(/^R\d+\tsrc\/old-name\.ts\tsrc\/new-name\.ts$/m);
  });

  it('SF-03 control: with the patch pass reading, the renamed file lists lonelyNew', () => {
    expect(control.exitCode).toBe(0);
    expect(listedNames(reportOf(control))).toContain('lonelyNew');
  });

  it('SF-03 runOrphans exits 1 for the renamed file, stderr saying git could not read the changed lines', () => {
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr ?? '').toMatch(UNREAD_PHRASE);
  });
});

describe('SF-03 control: a diff that only adds a file still runs with the patch pass failing', () => {
  let root = '';
  let result: OrphansResult;
  let hits = 0;

  beforeAll(async () => {
    root = newRepo('cg-orf-sf03-add-', { 'src/existing.ts': STABLE });
    write(root, 'src/fresh.ts', 'export function lonelyFresh(): number {\n  return 5;\n}\n');
    commitAll(root, 'C2: add src/fresh.ts');
    await indexAt(root);
    gitFault.failPatch = true;
    try {
      result = await runOrphans(root, { base: 'C1', format: 'json' });
      hits = gitFault.hits;
    } finally {
      gitFault.failPatch = false;
    }
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('SF-03 control: the patch pass failed, yet runOrphans exits 0 and lists lonelyFresh (an added file needs no ranges)', () => {
    expect(hits).toBeGreaterThan(0);
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(listedNames(reportOf(result))).toContain('lonelyFresh');
  });
});

describe('SF-03 control: a modified .ts file git diffs as binary (no hunks, patch pass read) is not refused', () => {
  let root = '';
  let result: OrphansResult;

  beforeAll(async () => {
    root = newRepo('cg-orf-sf03-bin-', { '.gitattributes': '*.ts -diff\n', 'src/diffless.ts': STABLE });
    write(root, 'src/diffless.ts', `${STABLE}\nexport function addedLater() {}\n`);
    commitAll(root, 'C2: append addedLater to a binary-diffed file');
    await indexAt(root);
    result = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('SF-03 control: exits 0 and lists addedLater (O-10 whole-file fallback)', () => {
    expect(result.stderr ?? '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(listedNames(reportOf(result))).toContain('addedLater');
  });
});

// ---------------------------------------------------------------------------
// R1-21 consumption: an uncommitted edit is part of the diff
// ---------------------------------------------------------------------------

/** C1 of src/mod.ts. */
const MOD_C1 = 'export function keep(): number {\n  return 1;\n}\n';
/** C2: addedFn committed. */
const MOD_C2 = `${MOD_C1}\nexport function addedFn() {\n  return 3;\n}\n`;
/** The uncommitted edit: a new unused function appended to the changed tracked file. */
const MOD_DIRTY = `${MOD_C2}\nexport function uncommittedFn() {\n  return 4;\n}\n`;

describe('R1-21: an uncommitted edit to a changed file is read from the working tree', () => {
  let root = '';
  let stale: OrphansResult;
  let staleFailure: string | null | undefined;
  let synced: OrphansResult;
  let syncedFailure: string | null | undefined;
  let mcpSynced: { text: string; isError?: boolean };

  const changed = [{ path: 'src/mod.ts', status: 'modified' as const }];
  /** The failure text for the check over src/mod.ts; undefined when git could not compare at all. */
  const failureNow = (): string | null | undefined => {
    const currency = checkIndexCurrency(root, changed);
    return currency === null ? undefined : currencyFailure(currency);
  };

  beforeAll(async () => {
    root = newRepo('cg-orf-r121-', { 'src/mod.ts': MOD_C1 });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
    write(root, 'src/mod.ts', MOD_DIRTY);
    // Not synced yet: the index holds C2's content.
    stale = await runOrphans(root, { base: 'C1', format: 'json' });
    staleFailure = failureNow();
    await syncAt(root);
    synced = await runOrphans(root, { base: 'C1', format: 'json' });
    syncedFailure = failureNow();
    const res = await orphansToolHandler({ projectPath: root, base: 'C1', format: 'json' });
    mcpSynced = { text: res.content[0].text, isError: (res as { isError?: boolean }).isError };
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('R1-21 fixture: src/mod.ts has an uncommitted edit', () => {
    expect(git(root, 'diff', '--name-only', 'HEAD')).toContain('src/mod.ts');
  });

  it('R1-21 synced: runOrphans exits 0 and lists the uncommitted uncommittedFn and the committed addedFn', () => {
    expect(synced.stderr ?? '').toBe('');
    expect(synced.exitCode).toBe(0);
    const names = listedNames(reportOf(synced));
    expect(names).toContain('uncommittedFn');
    expect(names).toContain('addedFn');
  });

  it('R1-21 synced: the json basis is "C1...HEAD plus uncommitted changes"', () => {
    expect(synced.exitCode).toBe(0);
    expect(reportOf(synced).basis).toBe('C1...HEAD plus uncommitted changes');
  });

  it('R1-21 synced: orphansToolHandler returns the report, uncommittedFn in it, with no isError', () => {
    expect(mcpSynced.text).toContain('uncommittedFn');
    expect(mcpSynced.isError).toBeFalsy();
  });

  it('R1-21 control: the same edit with the index not synced exits 1 with the "index has not caught up" guidance naming the file', () => {
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr ?? '').toContain('src/mod.ts');
    expect(stale.stderr ?? '').toMatch(/index has not caught up/);
  });

  it('R1-21 checkIndexCurrency: a synced uncommitted edit yields no refusal', () => {
    expect(syncedFailure).not.toBeUndefined();
    expect(syncedFailure).toBeNull();
  });

  it('R1-21 checkIndexCurrency: the unsynced edit yields a refusal naming src/mod.ts', () => {
    expect(staleFailure).toEqual(expect.any(String));
    expect(staleFailure ?? '').toContain('src/mod.ts');
  });
});

// ---------------------------------------------------------------------------
// R1-26 (path half): the mention search's path batches on win32
// ---------------------------------------------------------------------------

type BatchBytesFn = (platform?: NodeJS.Platform) => number | undefined;
type PatternBytesFn = (platform?: NodeJS.Platform) => number;

/** `mentionSearchBatchBytes` from index.ts, or undefined when it is not exported. */
function batchBytesApi(): BatchBytesFn | undefined {
  return 'mentionSearchBatchBytes' in orphansIndex
    ? (orphansIndex as unknown as { mentionSearchBatchBytes: BatchBytesFn }).mentionSearchBatchBytes
    : undefined;
}

/** `mentionPatternBytes` from orphans.ts (unit A), or undefined when it is not exported. */
function patternBytesApi(): PatternBytesFn | undefined {
  return 'mentionPatternBytes' in orphansCore
    ? (orphansCore as unknown as { mentionPatternBytes: PatternBytesFn }).mentionPatternBytes
    : undefined;
}

/** Windows' command-line limit, in UTF-16 units. */
const WIN32_COMMAND_LINE = 32_767;
/** The executable, the fixed rg arguments and quoting. */
const FIXED_OVERHEAD = 1024;

describe('R1-26 mentionSearchBatchBytes', () => {
  it('R1-26 index.ts exports mentionSearchBatchBytes', () => {
    expect(typeof batchBytesApi()).toBe('function');
  });

  it('R1-26 is 8 KiB on win32', () => {
    const fn = batchBytesApi();
    expect(typeof fn).toBe('function');
    expect(fn?.('win32')).toBe(8 * 1024);
  });

  it('R1-26 is undefined (grep\'s own default) on linux and darwin', () => {
    const fn = batchBytesApi();
    expect(typeof fn).toBe('function');
    expect(fn?.('linux')).toBeUndefined();
    expect(fn?.('darwin')).toBeUndefined();
  });

  it('R1-26 on win32 the pattern budget, the path batch and 1 KiB of fixed arguments stay under 32,767', () => {
    const batch = batchBytesApi();
    const pattern = patternBytesApi();
    expect(typeof batch).toBe('function');
    expect(typeof pattern).toBe('function');
    const total = (pattern?.('win32') ?? Infinity) + (batch?.('win32') ?? Infinity) + FIXED_OVERHEAD;
    expect(total).toBeLessThan(WIN32_COMMAND_LINE);
  });
});

describe('R1-26 the runner passes the win32 batch budget to searchIndexText', () => {
  let root = '';

  beforeAll(async () => {
    root = newRepo('cg-orf-r126-', { 'src/base.ts': STABLE });
    write(root, 'src/mod.ts', MOD_C2);
    commitAll(root, 'C2: add addedFn');
    await indexAt(root);
  }, 60_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('R1-26 with process.platform win32, every searchIndexText call carries batchBytes 8192', async () => {
    searchHooks.record = true;
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    let r: OrphansResult;
    try {
      r = await runOrphans(root, { base: 'C1', format: 'json' });
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
    expect(r.stderr ?? '').toBe('');
    expect(r.exitCode).toBe(0);
    expect(searchHooks.calls.length).toBeGreaterThan(0);
    for (const opts of searchHooks.calls) expect(opts?.batchBytes).toBe(8 * 1024);
  });

  it('R1-26 pin: on this platform (not win32) searchIndexText gets no batchBytes', async () => {
    expect(process.platform).not.toBe('win32');
    searchHooks.record = true;
    const r = await runOrphans(root, { base: 'C1', format: 'json' });
    expect(r.exitCode).toBe(0);
    expect(searchHooks.calls.length).toBeGreaterThan(0);
    for (const opts of searchHooks.calls) expect(opts?.batchBytes).toBeUndefined();
  });
});
