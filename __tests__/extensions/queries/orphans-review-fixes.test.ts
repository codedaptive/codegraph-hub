/**
 * `codegraph orphans`, review fixes, unit A (orphans core): fail-first tests for the
 * review findings SF-01, R1-26 (pattern half), R1-28, R1-29 with O-12 / KL-05, and a
 * characterization of R2-09. Each case runs `findOrphans` on a real CodeGraph index of a
 * fixture git repo (real git, real SQLite, no mocks), except the pure `containsWord` and
 * `mentionBatches` checks and one control that hands `findOrphans` a stub store.
 *
 * A test name starts with its finding id. Kinds of test:
 *   - the case itself: red on the code before its fix, at an assertion;
 *   - "control": a behaviour that holds before the fix and must keep holding after it;
 *   - "fixture": the index fact a case depends on, so a red case cannot pass or fail
 *     because its premise is false;
 *   - "characterization" (R2-09 only): green before the fix; it records that the
 *     inherited AST attribute read (O-05 / O-08) already settled the finding.
 *
 * Fixtures are built once per describe in beforeAll (indexing a repo takes a few seconds,
 * more on a loaded machine, hence the long beforeAll timeouts); the temp dirs are removed
 * in one afterAll. The tests themselves only read the built reports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { changedFiles, type ChangedFile } from '../../../src/extensions/queries/blast/diff';
import { grepIndex } from '../../../src/extensions/queries/grep/grep-core';
import * as orphansModule from '../../../src/extensions/queries/orphans/orphans';
import {
  MENTION_PATTERN_BYTES, MentionSearchIncompleteError, containsWord, findOrphans, mentionBatches, mentionPattern,
  type OrphanEntry, type OrphansIO, type OrphansReport,
} from '../../../src/extensions/queries/orphans/orphans';
import { openOrphansStore, type OrphansStore } from '../../../src/extensions/queries/orphans/store';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// --- fixture plumbing -------------------------------------------------------------

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

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
}

/** A repo with `c1` committed and tagged C1, then `c2` applied and committed, indexed at C2. */
async function fixtureRepo(prefix: string, c1: Record<string, string>, c2: (root: string) => void): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  git(root, 'init', '-q');
  writeAll(root, c1);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  c2(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');
  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();
  return root;
}

interface NodeRow { id: string; name: string; kind: string; file_path: string; language: string }
interface EdgeRow { source: string; target: string; kind: string; metadata: string | null }
interface IndexRows { nodes: NodeRow[]; edges: EdgeRow[] }

function indexRows(root: string): IndexRows {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    return {
      nodes: db.prepare(
        "SELECT id, name, kind, file_path, language FROM nodes WHERE kind NOT IN ('file','import','parameter')",
      ).all() as unknown as NodeRow[],
      edges: db.prepare('SELECT source, target, kind, metadata FROM edges').all() as unknown as EdgeRow[],
    };
  } finally {
    conn.close();
  }
}

/** `<path>#<kind>:<name>`: a Go method and a top-level function may share a name in one file. */
const keyOf = (n: { file_path?: string; path?: string; kind: string; name: string }): string =>
  `${n.file_path ?? n.path}#${n.kind}:${n.name}`;

/** The text-mention search through grep-by-symbol's grepIndex, as the inherited suites wire it. */
function ioFor(root: string): OrphansIO {
  return {
    preImage: (file: ChangedFile) => {
      const res = spawnSync('git', ['show', `C1:./${file.oldPath ?? file.path}`], { cwd: root, encoding: 'utf8' });
      return res.status === 0 ? res.stdout : null;
    },
    source: (rel) => {
      try {
        return fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    search: async (pattern, maxHits) => {
      const r = await grepIndex(root, pattern, { maxHits });
      return {
        hits: r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text }))),
        truncated: r.truncated.hits > 0,
        unread: r.truncated.files,
      };
    },
  };
}

/**
 * findOrphans over the C1 merge-base-to-working-tree files of `root` that `only` admits, with `wrap` around the real store
 * (a spy). Throws what findOrphans throws.
 */
async function orphansOf(
  root: string,
  only: (p: string) => boolean = () => true,
  wrap: (s: OrphansStore) => OrphansStore = (s) => s,
): Promise<OrphansReport> {
  const diff = changedFiles(root, 'C1');
  if (!diff) throw new Error('fixture: no diff against C1');
  const store = openOrphansStore(root);
  try {
    return await findOrphans(wrap(store), diff.files.filter((f) => only(f.path)), ioFor(root));
  } finally {
    store.close();
  }
}

const listed = (r: OrphansReport): OrphanEntry[] => [...r.orphans, ...r.guessed];
const listedKeys = (r: OrphansReport): string[] => listed(r).map(keyOf);
const listedNames = (r: OrphansReport): string[] => listed(r).map((e) => e.name);

// =====================================================================================
// SF-01 containsWord never throws on a name holding `-`.
// =====================================================================================

describe('SF-01 containsWord: a whole-word test that never throws', () => {
  it.each([
    ['a x-y b', 'x-y', true],
    ['a operator- b', 'operator-', true],
    ['a - b', '-', true],
    ['ax-yb', 'x-y', false],
    ['x-yz', 'x-y', false],
    ['zx-y', 'x-y', false],
    ['xoperator- b', 'operator-', false],
    ['a-b', '-', false],
  ])('SF-01: containsWord(%j, %j) is %s and does not throw', (text, name, expected) => {
    let got: boolean | string;
    try {
      got = containsWord(text, name);
    } catch (err) {
      got = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    expect(got).toBe(expected);
  });

  it.each([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'])(
    'SF-01: a name that is the one ASCII punctuation character %j is found between spaces, without a throw',
    (ch) => {
      let got: boolean | string;
      try {
        got = containsWord(`x ${ch} x`, ch);
      } catch (err) {
        got = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      expect(got).toBe(true);
    },
  );

  it('SF-01 control: whole-word semantics for an identifier: foo is not found in foobar, and is found in "a foo b"', () => {
    expect(containsWord('foobar', 'foo')).toBe(false);
    expect(containsWord('a foo b', 'foo')).toBe(true);
    expect(containsWord('a==b', '==')).toBe(false);
    expect(containsWord('a == b', '==')).toBe(true);
  });
});

// =====================================================================================
// R1-26 (pattern half): a platform-sized mention pattern budget.
// =====================================================================================

/** The export under test, read off the module namespace so a missing export fails at an assertion, not at import. */
const mentionPatternBytes = (orphansModule as unknown as Record<string, unknown>).mentionPatternBytes as
  | ((platform?: NodeJS.Platform) => number)
  | undefined;

/** 1,500 names of 96 bytes each: about 144 KiB of pattern, several batches at any budget here. */
const BATCH_NAMES = Array.from({ length: 1500 }, (_, i) => `m${'x'.repeat(91)}${String(i).padStart(4, '0')}`);

describe('R1-26 mentionPatternBytes: the mention pattern budget per platform', () => {
  it('R1-26: orphans exports mentionPatternBytes as a function', () => {
    expect(typeof mentionPatternBytes).toBe('function');
  });

  it('R1-26: the budget is 16 KiB on win32', () => {
    expect(typeof mentionPatternBytes).toBe('function');
    expect(mentionPatternBytes!('win32')).toBe(16 * 1024);
  });

  it.each(['darwin', 'linux'] as const)('R1-26: the budget is MENTION_PATTERN_BYTES (64 KiB) on %s', (platform) => {
    expect(typeof mentionPatternBytes).toBe('function');
    expect(MENTION_PATTERN_BYTES).toBe(64 * 1024);
    expect(mentionPatternBytes!(platform)).toBe(MENTION_PATTERN_BYTES);
  });

  it('R1-26: at the win32 budget every name lands in exactly one batch, in order, each batch pattern within 16 KiB', () => {
    expect(typeof mentionPatternBytes).toBe('function');
    const batches = mentionBatches(BATCH_NAMES, mentionPatternBytes!('win32'));
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(BATCH_NAMES);
    for (const b of batches) expect(Buffer.byteLength(mentionPattern(b))).toBeLessThanOrEqual(16 * 1024);
  });

  it('R1-26: the default budget of mentionBatches is mentionPatternBytes() of this platform', () => {
    expect(typeof mentionPatternBytes).toBe('function');
    expect(mentionBatches(BATCH_NAMES)).toEqual(mentionBatches(BATCH_NAMES, mentionPatternBytes!()));
  });

  it('R1-26 control: a name whose pattern alone is over the budget still forms a batch of its own', () => {
    const huge = 'h'.repeat(20 * 1024);
    const batches = mentionBatches(['a', huge, 'b'], 16 * 1024);
    expect(batches.flat()).toEqual(['a', huge, 'b']);
    expect(batches).toContainEqual([huge]);
  });

  it('R1-26 control: findOrphans refuses to search a name whose pattern alone is over the budget', async () => {
    // A stub store: one added, unused TypeScript function whose name is longer than any pattern budget.
    const huge = 'q'.repeat(70 * 1024);
    const empty = <K, V>(): Map<K, V> => new Map<K, V>();
    const store: OrphansStore = {
      symbolsOverlapping: () => [{ id: 'n1', name: huge, kind: 'function', path: 'src/huge.ts', span: 'L1-L1' }],
      nodesByIds: () => [],
      details: () => new Map([['n1', { language: 'typescript', startColumn: 0, endColumn: 10 }]]),
      incomingUses: () => [],
      parents: () => empty(),
      typesNamed: () => [],
      conformances: () => empty(),
      memberNames: () => empty(),
      externalConformances: () => empty(),
      failedRefsNamed: () => [],
      close: () => {},
    };
    const searched: string[] = [];
    const io: OrphansIO = {
      preImage: () => null,
      source: () => null,
      search: async (pattern) => {
        searched.push(pattern);
        return { hits: [], truncated: false, unread: 0 };
      },
    };
    const file: ChangedFile = { path: 'src/huge.ts', status: 'added', ranges: [], hunks: [] };
    await expect(findOrphans(store, [file], io)).rejects.toBeInstanceOf(MentionSearchIncompleteError);
    expect(searched).toEqual([]);
  });
});

// =====================================================================================
// R1-28 runtime entry points: Go `init`, Python dunder methods and module hooks.
// =====================================================================================

const ENTRY_C1: Record<string, string> = { 'src/base.ts': 'export function base(): number {\n  return 0;\n}\n' };
const ENTRY_C2: Record<string, string> = {
  'pkg/store/cache.go': [
    'package store',
    '',
    'var registry = map[string]int{}',
    '',
    'type Cache struct {',
    '\tn int',
    '}',
    '',
    'func (c *Cache) init() {',
    '\tc.n = 0',
    '}',
    '',
    'func init() {',
    '\tregistry["cache"] = 1',
    '}',
    '',
    'func unusedGoHelper() int {',
    '\treturn 2',
    '}',
    '',
  ].join('\n'),
  'lib/bag.py': [
    'class Bag:',
    '    items = []',
    '',
    '    def __len__(self):',
    '        return 0',
    '',
    '    def __eq__(self, other):',
    '        return self is other',
    '',
    '    def plain_method(self):',
    '        return 1',
    '',
  ].join('\n'),
  'lib/lazy.py': 'def __getattr__(name):\n    raise AttributeError(name)\n\n\ndef __dir__():\n    return []\n',
  'lib/helpers.py': 'def plain_function():\n    return 1\n\n\ndef __helper__():\n    return 2\n',
  'src/init.ts': 'export function init(): number {\n  return 1;\n}\n',
};

describe('R1-28 runtime entry points: Go init and Python dunders are not orphans', () => {
  let root = '';
  let ix: IndexRows;
  let report: OrphansReport;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-rf-entry-', ENTRY_C1, (r) => writeAll(r, ENTRY_C2));
    ix = indexRows(root);
    report = await orphansOf(root);
  }, 120_000);

  it('R1-28 fixture: the Go init function and method, the Python dunders and the controls are nodes of the kinds the cases assume', () => {
    expect(ix.nodes.map(keyOf)).toEqual(expect.arrayContaining([
      'pkg/store/cache.go#function:init',
      'pkg/store/cache.go#method:init',
      'pkg/store/cache.go#function:unusedGoHelper',
      'lib/bag.py#method:__len__',
      'lib/bag.py#method:__eq__',
      'lib/bag.py#method:plain_method',
      'lib/lazy.py#function:__getattr__',
      'lib/lazy.py#function:__dir__',
      'lib/helpers.py#function:plain_function',
      'lib/helpers.py#function:__helper__',
      'src/init.ts#function:init',
    ]));
  });

  it('R1-28: a top-level Go func init() is not listed', () => {
    expect(listedKeys(report)).not.toContain('pkg/store/cache.go#function:init');
  });

  it('R1-28: Python dunder methods __len__ and __eq__ are not listed', () => {
    expect(listedKeys(report)).not.toContain('lib/bag.py#method:__len__');
    expect(listedKeys(report)).not.toContain('lib/bag.py#method:__eq__');
  });

  it('R1-28: module-level Python __getattr__ and __dir__ are not listed', () => {
    expect(listedKeys(report)).not.toContain('lib/lazy.py#function:__getattr__');
    expect(listedKeys(report)).not.toContain('lib/lazy.py#function:__dir__');
  });

  it('R1-28: those five are counted as entry points and under no other exclusion', () => {
    expect(report.excluded).toEqual({ test: 0, implementation: 0, constructor: 0, entry: 5 });
  });

  it('R1-28 control: an ordinary unused Go function and a Go method named init stay listed', () => {
    expect(listedKeys(report)).toContain('pkg/store/cache.go#function:unusedGoHelper');
    expect(listedKeys(report)).toContain('pkg/store/cache.go#method:init');
  });

  // A Go `init` nested in a function cannot be written: Go has no nested named function
  // declarations (only function literals), so that control is not built.

  it('R1-28 control: an ordinary unused Python function and method stay listed', () => {
    expect(listedKeys(report)).toContain('lib/helpers.py#function:plain_function');
    expect(listedKeys(report)).toContain('lib/bag.py#method:plain_method');
  });

  it('R1-28 control: a module-level Python dunder that is no runtime hook (__helper__) stays listed', () => {
    expect(listedKeys(report)).toContain('lib/helpers.py#function:__helper__');
  });

  it('R1-28 control: an unused TypeScript function named init stays listed', () => {
    expect(listedKeys(report)).toContain('src/init.ts#function:init');
  });
});

// =====================================================================================
// R1-29 + O-12 / KL-05: same-named types outside Swift are independent; typesNamed is Swift-only.
// =====================================================================================

const SAME_C1: Record<string, string> = {
  'src/a.ts': 'export class Widget {}\n',
  'src/use.ts': "import { Widget } from './a';\n\nexport function make(): Widget {\n  return new Widget();\n}\n",
  'py/a.py': 'class Widget:\n    pass\n',
  'py/use.py': 'from a import Widget\n\n\ndef make():\n    return Widget()\n',
  // The use sits in the struct's own file: a cross-file exact-match call is a guess under isCandidateEdge, and
  // the control wants the struct's group certainly used.
  'Sources/Pkg/Sprocket.swift': 'struct Sprocket: Encodable {}\n\nfunc makeSprocket() -> Sprocket {\n    return Sprocket()\n}\n',
};
const SAME_C2: Record<string, string> = {
  'src/b.ts': 'export class Widget {}\n',
  'py/b.py': 'class Widget:\n    pass\n',
  'Sources/Pkg/Ext.swift': 'extension Sprocket {\n    func encode(to encoder: Encoder) throws {}\n}\n',
};

/** A store that records the names of every `typesNamed` call and passes it on to the real one. */
function spyTypesNamed(calls: string[][]): (s: OrphansStore) => OrphansStore {
  return (s) => new Proxy(s, {
    get(target, prop, receiver) {
      if (prop === 'typesNamed') {
        return (names: readonly string[], kinds: readonly string[]) => {
          calls.push([...names]);
          return target.typesNamed(names, kinds);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe('R1-29 same-named types outside Swift do not share uses; O-12 typesNamed reads Swift names only', () => {
  let root = '';
  let ix: IndexRows;
  let report: OrphansReport;
  let allCalls: string[][] = [];
  let nonSwiftCalls: string[][] = [];

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-rf-same-name-', SAME_C1, (r) => writeAll(r, SAME_C2));
    ix = indexRows(root);
    allCalls = [];
    report = await orphansOf(root, () => true, spyTypesNamed(allCalls));
    nonSwiftCalls = [];
    await orphansOf(root, (p) => p.startsWith('src/') || p.startsWith('py/'), spyTypesNamed(nonSwiftCalls));
  }, 120_000);

  const node = (name: string, file: string): NodeRow | undefined =>
    ix.nodes.find((n) => n.name === name && n.file_path === file);
  const usesOf = (id: string): EdgeRow[] => ix.edges.filter((e) => e.target === id && e.kind !== 'contains' && e.kind !== 'exports');
  const entryAt = (name: string, file: string): OrphanEntry | undefined =>
    listed(report).find((e) => e.name === name && e.path === file);

  it('R1-29 fixture: src/use.ts uses the Widget of src/a.ts; nothing uses the Widget of src/b.ts', () => {
    const a = node('Widget', 'src/a.ts');
    const b = node('Widget', 'src/b.ts');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(usesOf(a!.id).length).toBeGreaterThan(0);
    expect(usesOf(b!.id)).toEqual([]);
  });

  it('R1-29: the unrelated TypeScript Widget in src/b.ts is listed, and its evidence is not a use of src/a.ts\'s Widget', () => {
    const e = entryAt('Widget', 'src/b.ts');
    expect(e).toBeDefined();
    const guessed = report.guessed.find((g) => g.name === 'Widget' && g.path === 'src/b.ts');
    if (guessed) expect(guessed.edges).toEqual([]);
  });

  it('R1-29 fixture: py/use.py uses the Widget of py/a.py; nothing uses the Widget of py/b.py', () => {
    const a = node('Widget', 'py/a.py');
    const b = node('Widget', 'py/b.py');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(usesOf(a!.id).length).toBeGreaterThan(0);
    expect(usesOf(b!.id)).toEqual([]);
  });

  it('R1-29: the unrelated Python Widget in py/b.py is listed, and its evidence is not a use of py/a.py\'s Widget', () => {
    const e = entryAt('Widget', 'py/b.py');
    expect(e).toBeDefined();
    const guessed = report.guessed.find((g) => g.name === 'Widget' && g.path === 'py/b.py');
    if (guessed) expect(guessed.edges).toEqual([]);
  });

  it('R1-29 control (Swift): the added extension Sprocket joins the used struct Sprocket of the same path, so it is not listed', () => {
    expect(node('Sprocket', 'Sources/Pkg/Ext.swift')).toBeDefined();
    expect(entryAt('Sprocket', 'Sources/Pkg/Ext.swift')).toBeUndefined();
  });

  it('R1-29 control (Swift): encode in the extension is excluded through the joined struct\'s Encodable conformance', () => {
    expect(node('encode', 'Sources/Pkg/Ext.swift')).toBeDefined();
    expect(listedNames(report)).not.toContain('encode');
    expect(report.excluded.implementation).toBe(1);
  });

  it('O-12: typesNamed is called, and only with names of Swift type nodes', () => {
    const swiftTypeNames = new Set(
      ix.nodes
        .filter((n) => n.language === 'swift' && ['class', 'struct', 'enum', 'protocol', 'interface', 'trait', 'union'].includes(n.kind))
        .map((n) => n.name),
    );
    const names = allCalls.flat();
    expect(names).toContain('Sprocket');
    expect(names.filter((n) => !swiftTypeNames.has(n))).toEqual([]);
  });

  it('O-12: a run whose added and containing types are all non-Swift makes no typesNamed call', () => {
    expect(nonSwiftCalls).toEqual([]);
  });
});

// =====================================================================================
// R2-09 characterization: the attribute look-back. Expected GREEN on the code before
// this request's fix: the inherited AST attribute read (O-05 / O-08) already settled it.
// Ported from the published orphans-completeness repos E and F.
// =====================================================================================

describe('R2-09 characterization: an attribute line that carries code after its attributes ends the look-back', () => {
  let root = '';
  let ix: IndexRows;
  let report: OrphansReport;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-rf-attr-e-', {
      'Cargo.toml': '[package]\nname = "attrs"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn used() -> i32 { 1 }\n\n#[test] fn smoke() {}\n',
      'src/own_line.rs': 'pub fn anchor_own() -> i32 { 2 }\n',
      'src/bracket.rs': 'pub fn anchor_bracket() -> i32 { 3 }\n',
      'src/cfg_attr.rs': 'pub fn anchor_cfg() -> i32 { 4 }\n',
      'Sources/Feature/Feature.swift': 'func anchorSwift() -> Int { 1 }\n\n@Test func smoke() {}\n',
      'Sources/App/App.swift': '@main struct MainApp {}\n',
      'Sources/App/Own.swift': 'struct Anchor {}\n',
    }, (r) => {
      const append = (rel: string, text: string): void => fs.appendFileSync(path.join(r, rel), text);
      append('src/lib.rs', 'fn real() {}\n');
      append('src/own_line.rs', '\n#[test]\nfn own_line_test() {}\n');
      append('src/bracket.rs', '\n#[test]\n#[doc = "]"]\nfn doc_bracket_test() {}\n');
      append('src/cfg_attr.rs', '\n#[test]\n#[cfg_attr(test, allow(dead_code))]\nfn cfg_attr_test() {}\n');
      append('Sources/Feature/Feature.swift', 'func realSwift() {}\n');
      append('Sources/App/App.swift', 'struct NotMain {}\n');
      append('Sources/App/Own.swift', '@main\nstruct OwnLineMain {}\n');
    });
    ix = indexRows(root);
    report = await orphansOf(root);
  }, 120_000);

  it('R2-09 fixture: each added function and type is a node of its file, with the kind the rules read', () => {
    expect(ix.nodes.map(keyOf)).toEqual(expect.arrayContaining([
      'src/lib.rs#function:real',
      'src/own_line.rs#function:own_line_test',
      'src/bracket.rs#function:doc_bracket_test',
      'src/cfg_attr.rs#function:cfg_attr_test',
      'Sources/Feature/Feature.swift#function:realSwift',
      'Sources/App/App.swift#struct:NotMain',
      'Sources/App/Own.swift#struct:OwnLineMain',
    ]));
  });

  it('R2-09: a Rust fn real() added below `#[test] fn smoke() {}` is orphaned, not excluded as a test', () => {
    expect(report.orphans.map((o) => o.name)).toContain('real');
  });

  it('R2-09: a Swift func realSwift() added below `@Test func smoke() {}` is orphaned, not excluded as a test', () => {
    expect(report.orphans.map((o) => o.name)).toContain('realSwift');
  });

  it('R2-09: a struct added below `@main struct MainApp {}` is no entry point: it is orphaned', () => {
    expect(report.orphans.map((o) => o.name)).toContain('NotMain');
  });

  it('R2-09 control: exactly three functions are excluded as tests, the ones under their own attribute lines', () => {
    expect(report.excluded.test).toBe(3);
    for (const n of ['own_line_test', 'doc_bracket_test', 'cfg_attr_test']) expect(listedNames(report)).not.toContain(n);
  });

  it('R2-09 control: a `@main` on its own line still makes the struct below it an entry point', () => {
    expect(listedNames(report)).not.toContain('OwnLineMain');
  });
});

describe('R2-09 characterization: the look-back reads past a block comment and a raw string on an attribute line', () => {
  let root = '';
  let ix: IndexRows;
  let report: OrphansReport;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-rf-attr-f-', {
      'Cargo.toml': '[package]\nname = "attrs-raw"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn used() -> i32 { 1 }\n\n#[test] /* explanation */ fn smoke2() {}\n',
      'src/raw.rs': 'pub fn anchor_raw() -> i32 { 2 }\n',
      'src/comment_attr.rs': 'pub fn anchor_comment() -> i32 { 5 }\n\n#[test] #[allow(dead_code /* r#"example" */)] fn smoke3() {}\n',
      'src/nested.rs': 'pub fn anchor_nested() -> i32 { 6 }\n',
    }, (r) => {
      const append = (rel: string, text: string): void => fs.appendFileSync(path.join(r, rel), text);
      append('src/lib.rs', 'fn never_called_block() {}\n');
      append('src/raw.rs', '\n#[test]\n#[doc = r#"a "]" marker"#]\nfn raw_doc_test() {}\n');
      append('src/comment_attr.rs', 'fn never_called_c() {}\n');
      append('src/nested.rs', '\n#[test] /* outer /* inner */ outer */\nfn smoke4() {}\n');
    });
    ix = indexRows(root);
    report = await orphansOf(root);
  }, 120_000);

  it('R2-09 fixture: never_called_block, raw_doc_test, never_called_c and smoke4 are Rust function nodes of their files', () => {
    expect(ix.nodes.map(keyOf)).toEqual(expect.arrayContaining([
      'src/lib.rs#function:never_called_block',
      'src/raw.rs#function:raw_doc_test',
      'src/comment_attr.rs#function:never_called_c',
      'src/nested.rs#function:smoke4',
    ]));
  });

  it('R2-09: a function added below `#[test] /* explanation */ fn smoke2() {}` is orphaned, not excluded as a test', () => {
    expect(report.orphans.map((o) => o.name)).toContain('never_called_block');
  });

  it('R2-09: a function added below `#[test] #[allow(dead_code /* r#"example" */)] fn smoke3() {}` is orphaned', () => {
    expect(report.orphans.map((o) => o.name)).toContain('never_called_c');
  });

  it('R2-09 control: a `#[test]` above a `#[doc = r#"a "]" marker"#]` line still excludes the function below', () => {
    expect(listedNames(report)).not.toContain('raw_doc_test');
  });

  it('R2-09 control: a `#[test]` with a nested block comment on its line still excludes the function below', () => {
    expect(listedNames(report)).not.toContain('smoke4');
  });
});
