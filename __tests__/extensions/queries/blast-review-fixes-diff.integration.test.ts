/**
 * Git diff handling for blast:
 *   - `changedFiles(root, base)` diffs the base's merge base against the working
 *     tree, so staged and unstaged tracked edits count and the ranges are in
 *     working-tree lines. Its basis label says when the tree is dirty. The check
 *     covers only the project directory, and an unrelated base gives null.
 *   - `applyHunks` marks a pure deletion (`+N,0`) with `deletion: true`, at line N.
 *   - `hasUnreadRanges(file)` names a file whose patch pass failed, without adding
 *     a property to the file.
 *
 * Real git in temp repos. The seed vectors index their repo, as blast.test.ts
 * does. A failed patch pass is a vi.mock of the shared git runner that wraps the
 * real one and fails only the `--unified=0` call while `gitFault.failPatch` is on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import * as diffModule from '../../../src/extensions/queries/blast/diff';
import { applyHunks, changedFiles, type ChangedFile } from '../../../src/extensions/queries/blast/diff';
import { runBlast } from '../../../src/extensions/queries/blast/index';
import type { BlastReport } from '../../../src/extensions/queries/blast/blast';

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

/**
 * `hasUnreadRanges` from diff.ts. The export is checked first, so a missing export
 * fails as an assertion rather than as a TypeError.
 */
const diffExports = diffModule as unknown as { hasUnreadRanges?: (file: ChangedFile) => boolean };
function unread(file: ChangedFile): boolean {
  expect(typeof diffExports.hasUnreadRanges, 'diff.ts exports hasUnreadRanges').toBe('function');
  return diffExports.hasUnreadRanges?.(file) ?? false;
}

const dirs: string[] = [];

afterEach(() => {
  gitFault.failPatch = false;
  gitFault.hits = 0;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

function write(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** An empty temp git repo, removed after the test. */
function tempRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  git(root, 'init', '-q');
  return root;
}

async function index(root: string): Promise<void> {
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
}

const names = (xs: { name: string }[]): string[] => xs.map((x) => x.name);

/** A changed-file record with no ranges yet, as parseNameStatus leaves it. */
function bare(p: string): ChangedFile {
  return { path: p, status: 'modified', ranges: [], hunks: [] };
}

const FIVE_LINES = 'export function f(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
/** `second`'s return is line 6 of C1. */
const FIRST_AND_SECOND = 'export function first(): number {\n  return 1;\n}\n\nexport function second(): number {\n  return 2;\n}\n';
const SECOND_EDITED = FIRST_AND_SECOND.replace('return 2;', 'return 22;');
/** Four lines above the committed change move it from line 6 to line 10 on disk. */
const FOUR_COMMENTS = '// one\n// two\n// three\n// four\n';

/** src/x.ts at C1 (tagged), then `second`'s return changed and committed as C2. The tree is clean. */
function secondCommittedRepo(): string {
  const root = tempRepo('cg-blast-unc-');
  write(root, 'src/x.ts', FIRST_AND_SECOND);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  write(root, 'src/x.ts', SECOND_EDITED);
  git(root, 'commit', '-q', '-am', 'C2: second body');
  return root;
}

/** A repo holding `pkg/` (the project) and `other/` (outside it), with C2 changing pkg/src/x.ts line 3. */
function subprojectRepo(): string {
  const root = tempRepo('cg-blast-sub-');
  write(root, 'pkg/src/x.ts', FIVE_LINES);
  write(root, 'other/y.ts', 'export const y = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  write(root, 'pkg/src/x.ts', FIVE_LINES.replace('const b = 2;', 'const b = 3;'));
  git(root, 'commit', '-q', '-am', 'C2: pkg edit');
  return root;
}

/** src/x.ts modified and src/new.ts added in C2, on top of C1 (tagged). The tree is clean. */
function modifiedAndAddedRepo(): string {
  const root = tempRepo('cg-blast-unread-');
  write(root, 'src/x.ts', FIVE_LINES);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  write(root, 'src/x.ts', FIVE_LINES.replace('const b = 2;', 'const b = 3;'));
  write(root, 'src/new.ts', 'export function fresh(): number {\n  return 1;\n}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2');
  return root;
}

describe('changedFiles diffs a base against the working tree', () => {
  it.each([false, true])(
    'reads a base diff in working-tree line numbers when the tree has uncommitted edits (staged=%s); an untracked file stays out',
    (staged) => {
      const root = secondCommittedRepo();
      write(root, 'src/x.ts', FOUR_COMMENTS + SECOND_EDITED);
      if (staged) git(root, 'add', 'src/x.ts');
      write(root, 'src/scratch.ts', 'export const scratch = 1;\n');
      const cs = changedFiles(root, 'C1');
      expect(cs).not.toBeNull();
      expect(cs!.basis).toBe('C1...HEAD plus uncommitted changes');
      expect(cs!.files.map((f) => [f.path, f.ranges])).toEqual([
        ['src/x.ts', [{ start: 1, end: 4 }, { start: 10, end: 10 }]],
      ]);
    },
  );

  it.each([false, true])(
    'seeds the function holding an uncommitted edit, not its neighbour, through blast (staged=%s)',
    async (staged) => {
      const root = secondCommittedRepo();
      write(root, 'src/x.ts', FOUR_COMMENTS + SECOND_EDITED);
      if (staged) git(root, 'add', 'src/x.ts');
      await index(root);
      const r = runBlast(root, { base: 'C1', format: 'json' });
      expect(r.exitCode).toBe(0);
      const report = JSON.parse(r.output) as BlastReport;
      expect(report.basis).toBe('C1...HEAD plus uncommitted changes');
      expect(names(report.seeds)).toContain('second');
      expect(names(report.seeds)).not.toContain('first');
    },
    30_000,
  );

  it('labels a clean committed tree exactly base...HEAD', () => {
    const root = secondCommittedRepo();
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD');
    expect(cs!.files[0].ranges).toEqual([{ start: 6, end: 6 }]);
  });

  it('a dirty file outside the project leaves the basis at base...HEAD, with paths relative to the project', () => {
    const root = subprojectRepo();
    write(root, 'other/y.ts', 'export const y = 2;\n');
    const cs = changedFiles(path.join(root, 'pkg'), 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD');
    expect(cs!.files.map((f) => [f.path, f.ranges])).toEqual([['src/x.ts', [{ start: 3, end: 3 }]]]);
  });

  it('a dirty file inside the project labels the basis base...HEAD plus uncommitted changes', () => {
    const root = subprojectRepo();
    write(root, 'pkg/src/x.ts', FIVE_LINES.replace('const a = 1;', 'const a = 9;'));
    const cs = changedFiles(path.join(root, 'pkg'), 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.basis).toBe('C1...HEAD plus uncommitted changes');
    expect(cs!.files.map((f) => f.path)).toEqual(['src/x.ts']);
  });

  it('returns null when base and HEAD share no merge base, even with an uncommitted edit', () => {
    const root = tempRepo('cg-blast-unrelated-');
    git(root, 'checkout', '-q', '--orphan', 'island');
    write(root, 'island.ts', 'export const island = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'island');
    fs.rmSync(path.join(root, 'island.ts'));
    git(root, 'checkout', '-q', '--orphan', 'work');
    write(root, 'src/x.ts', FIVE_LINES);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    write(root, 'src/x.ts', FIVE_LINES.replace('const b = 2;', 'const b = 3;'));
    expect(changedFiles(root, 'island')).toBeNull();
  });
});

describe('applyHunks marks a pure deletion with deletion: true', () => {
  it('marks a deletion at the top of the file as deletion: true at line 0', () => {
    const files = [bare('x.ts')];
    applyHunks(files, ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +0,0 @@', '-first', '-second', ''].join('\n'));
    expect(files[0].ranges).toEqual([{ start: 0, end: 0, deletion: true }]);
    expect(files[0].hunks[0]).toMatchObject({ start: 0, end: 0, deletion: true });
  });

  it('marks a pure deletion range and its hunk with deletion: true, and leaves the key off a plain change', () => {
    const files = [bare('x.ts')];
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '@@ -9,2 +8,0 @@',
      '-gone one',
      '-gone two',
      '',
    ].join('\n');
    applyHunks(files, patch);
    const [change, gap] = files[0].ranges;
    expect('deletion' in change).toBe(false);
    expect(gap).toEqual({ start: 8, end: 8, deletion: true });
    const [changeHunk, gapHunk] = files[0].hunks;
    expect('deletion' in changeHunk).toBe(false);
    expect(gapHunk).toMatchObject({ start: 8, end: 8, deletion: true });
  });
});

describe('hasUnreadRanges when the patch pass fails', () => {
  it('marks a modified and an added file unread, with no ranges, when the patch pass fails', () => {
    const root = modifiedAndAddedRepo();
    gitFault.failPatch = true;
    const cs = changedFiles(root, 'C1');
    expect(gitFault.hits).toBeGreaterThan(0);
    expect(cs).not.toBeNull();
    expect(cs!.files).toHaveLength(2);
    const byPath = new Map(cs!.files.map((f) => [f.path, f]));
    expect(byPath.get('src/x.ts')?.status).toBe('modified');
    expect(byPath.get('src/new.ts')?.status).toBe('added');
    for (const f of cs!.files) {
      expect(f.ranges).toEqual([]);
      expect(unread(f)).toBe(true);
    }
  });

  it('does not mark a file whose patch pass succeeded', () => {
    const root = modifiedAndAddedRepo();
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.files).toHaveLength(2);
    for (const f of cs!.files) {
      expect(f.ranges.length).toBeGreaterThan(0);
      expect(unread(f)).toBe(false);
    }
  });

  it('does not mark a binary change, whose patch pass succeeded with no hunks', () => {
    const root = tempRepo('cg-blast-binary-');
    write(root, 'assets/logo.bin', Buffer.from([0x00, 0x01, 0x02]));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    git(root, 'tag', 'C1');
    write(root, 'assets/logo.bin', Buffer.from([0x00, 0x09, 0x02]));
    git(root, 'commit', '-q', '-am', 'C2: binary');
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    expect(cs!.files.map((f) => [f.path, f.status, f.ranges])).toEqual([['assets/logo.bin', 'modified', []]]);
    expect(unread(cs!.files[0])).toBe(false);
  });

  it('keeps the unread mark out of the file: its own keys and its JSON are unchanged', () => {
    const root = modifiedAndAddedRepo();
    gitFault.failPatch = true;
    const cs = changedFiles(root, 'C1');
    expect(cs).not.toBeNull();
    const x = cs!.files.find((f) => f.path === 'src/x.ts')!;
    expect(Object.getOwnPropertySymbols(x)).toEqual([]);
    expect(Object.keys(x).sort()).toEqual(['hunks', 'path', 'ranges', 'status']);
    expect(JSON.parse(JSON.stringify(x))).toEqual({ path: 'src/x.ts', status: 'modified', ranges: [], hunks: [] });
    expect(unread(x)).toBe(true);
  });
});
