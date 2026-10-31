/**
 * The session focus in grep, in process (no server): `grepIndex`'s `focus` option and `handleGrepTool`'s
 * `sessionFocus` argument. The end-to-end behaviour over `serve --mcp --focus` is pinned by
 * focus-grep-blast.gate.test.ts; this file pins the pieces under it.
 *
 * Fixture (one repository, indexed once): src/app and src/lib both hold "SHARED-MARK", src/lib alone holds
 * "LIB-ONLY-MARK", src/appx (a sibling whose name starts with "app") holds "SHARED-MARK" too, to pin that a focus
 * on src/app is segment-aware. Nothing holds "NOWHERE-MARK".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { GrepScopeError, grepIndex, handleGrepTool } from '../../../src/extensions/queries/grep';

const FILES: Record<string, string> = {
  'src/app/one.ts': 'export function appOne(): string {\n  return "SHARED-MARK app";\n}\n',
  'src/app/two.ts': 'export function appTwo(): string {\n  return "SHARED-MARK app two";\n}\n',
  'src/lib/lib.ts': 'export function libOne(): string {\n  return "SHARED-MARK LIB-ONLY-MARK";\n}\n',
  'src/appx/x.ts': 'export function appxOne(): string {\n  return "SHARED-MARK appx";\n}\n',
};

const NOTHING_IN_FOCUS = (dirs: string): string =>
  `No results inside this session's focus (${dirs}). Pass scope: "repo" to search the whole repository.`;

let root: string;
let cg: CodeGraph;
let appFocus: string[];

const textOf = (r: { content: ReadonlyArray<{ text: string }> }): string => r.content[0]!.text;
const groupPaths = (json: string): string[] => (JSON.parse(json) as { groups: Array<{ path: string }> }).groups.map((g) => g.path).sort();

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-grep-focus-')));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  appFocus = [path.join(root, 'src', 'app')];
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('grepIndex with focus prefixes', () => {
  it('searches and groups only in-focus files, and filesSearched counts them', async () => {
    const whole = await grepIndex(root, 'SHARED-MARK');
    expect(whole.groups.map((g) => g.path).sort()).toEqual(['src/app/one.ts', 'src/app/two.ts', 'src/appx/x.ts', 'src/lib/lib.ts']);
    expect(whole.filesSearched).toBe(4);

    const focused = await grepIndex(root, 'SHARED-MARK', { focus: ['src/app'] });
    expect(focused.groups.map((g) => g.path).sort()).toEqual(['src/app/one.ts', 'src/app/two.ts']);
    expect(focused.totalHits).toBe(2);
    expect(focused.filesSearched).toBe(2);
  });

  it('a prefix may name a file, and several prefixes add up', async () => {
    const r = await grepIndex(root, 'SHARED-MARK', { focus: ['src/app/one.ts', 'src/lib'] });
    expect(r.groups.map((g) => g.path).sort()).toEqual(['src/app/one.ts', 'src/lib/lib.ts']);
    expect(r.filesSearched).toBe(2);
  });

  it('null and absent filter nothing, [] leaves nothing to search', async () => {
    const whole = await grepIndex(root, 'SHARED-MARK');
    expect(await grepIndex(root, 'SHARED-MARK', { focus: null })).toEqual(whole);
    expect(await grepIndex(root, 'SHARED-MARK', { focus: undefined })).toEqual(whole);
    const none = await grepIndex(root, 'SHARED-MARK', { focus: [] });
    expect(none.totalHits).toBe(0);
    expect(none.filesSearched).toBe(0);
  });

  it('an `in` that holds indexed files only outside the focus finds nothing instead of throwing GrepScopeError', async () => {
    const r = await grepIndex(root, 'SHARED-MARK', { in: 'src/lib', focus: ['src/app'] });
    expect(r.totalHits).toBe(0);
    expect(r.filesSearched).toBe(0);
    // An `in` with no indexed file at all is still the scope error, focus or not.
    await expect(grepIndex(root, 'SHARED-MARK', { in: 'nope', focus: ['src/app'] })).rejects.toBeInstanceOf(GrepScopeError);
  });

  it('out-of-focus hits take no slot of the hit cap', async () => {
    // maxHits 2: the whole index has 4 hits, so 2 are dropped; inside src/app both of its hits are kept.
    const whole = await grepIndex(root, 'SHARED-MARK', { maxHits: 2 });
    expect(whole.truncated.hits).toBe(2);
    const focused = await grepIndex(root, 'SHARED-MARK', { maxHits: 2, focus: ['src/app'] });
    expect(focused.totalHits).toBe(2);
    expect(focused.truncated.hits).toBe(0);
  });
});

describe('handleGrepTool with a session focus', () => {
  it('narrows to the focus by default and widens with scope "repo"', async () => {
    const narrow = await handleGrepTool({ pattern: 'SHARED-MARK', json: true }, root, appFocus);
    expect(groupPaths(textOf(narrow))).toEqual(['src/app/one.ts', 'src/app/two.ts']);
    const text = textOf(await handleGrepTool({ pattern: 'SHARED-MARK' }, root, appFocus));
    expect(text).toContain('src/app/one.ts');
    expect(text).not.toContain('src/lib/');
    expect(text).not.toContain('src/appx/');

    const wide = await handleGrepTool({ pattern: 'SHARED-MARK', json: true, scope: 'repo' }, root, appFocus);
    expect(groupPaths(textOf(wide))).toEqual(['src/app/one.ts', 'src/app/two.ts', 'src/appx/x.ts', 'src/lib/lib.ts']);
  });

  it('a scope other than "repo" keeps the focus', async () => {
    const r = await handleGrepTool({ pattern: 'SHARED-MARK', json: true, scope: 'focus' }, root, appFocus);
    expect(groupPaths(textOf(r))).toEqual(['src/app/one.ts', 'src/app/two.ts']);
  });

  it('answers the nothing-in-focus sentence, not an error, when hits exist only outside the focus', async () => {
    const r = await handleGrepTool({ pattern: 'LIB-ONLY-MARK' }, root, appFocus);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(NOTHING_IN_FOCUS('src/app'));
    // An `in` outside the focus is the same answer, not a scope error.
    const inOutside = await handleGrepTool({ pattern: 'SHARED-MARK', in: 'src/lib' }, root, appFocus);
    expect(inOutside.isError).toBeFalsy();
    expect(textOf(inOutside)).toBe(NOTHING_IN_FOCUS('src/app'));
    // scope "repo" finds it.
    expect(textOf(await handleGrepTool({ pattern: 'LIB-ONLY-MARK', scope: 'repo' }, root, appFocus))).toContain('src/lib/lib.ts');
  });

  it('answers the zero-hit note of the whole index when nothing matches anywhere', async () => {
    const r = await handleGrepTool({ pattern: 'NOWHERE-MARK' }, root, appFocus);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe((await handleGrepTool({ pattern: 'NOWHERE-MARK' }, root)).content[0]!.text);
    expect(textOf(r)).toContain('no hits for "NOWHERE-MARK" in 4 indexed files');
  });

  it('names the focus relative to the index when no focus directory lies inside it', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-grep-focus-elsewhere-')));
    try {
      const r = await handleGrepTool({ pattern: 'SHARED-MARK' }, root, [elsewhere]);
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe(NOTHING_IN_FOCUS(path.relative(root, elsewhere).split(path.sep).join('/')));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('with no focus ([] or undefined) answers byte for byte as the unfocused call, in text and json', async () => {
    for (const args of [
      { pattern: 'SHARED-MARK' },
      { pattern: 'SHARED-MARK', json: true },
      { pattern: 'NOWHERE-MARK' },
      { pattern: 'SHARED-MARK', in: 'src/lib' },
    ]) {
      const plain = await handleGrepTool(args, root);
      expect(await handleGrepTool(args, root, [])).toEqual(plain);
      expect(await handleGrepTool(args, root, undefined)).toEqual(plain);
    }
  });

  it('a focus on the whole index filters nothing', async () => {
    const plain = await handleGrepTool({ pattern: 'SHARED-MARK' }, root);
    expect(await handleGrepTool({ pattern: 'SHARED-MARK' }, root, [root])).toEqual(plain);
  });
});
