/**
 * `codegraph orphans`, unit B (orphans-core): the contract cases O-01 to O-10 as
 * fail-first tests. Each case runs on a real CodeGraph index of a fixture git repo
 * (real git, real SQLite, no mocks). `findOrphans` gets the changed files a case
 * names (every indexed file is still searched for mentions); `runOrphans` gives
 * what the CLI prints.
 *
 * A test name starts with its case id. Three kinds of test:
 *   - the case itself: red on the code before its fix, at an assertion (for O-02,
 *     a throw from findOrphans, which the test reports as its assertion failure);
 *     it passes on the code after the fix (the round-2 cases R2-1 to R2-4 after
 *     the Swift local-type fix, 7fdd6640);
 *   - "pin": a behaviour that holds before the fix and must keep holding after it;
 *   - "fixture": the index fact a case depends on, so a red case cannot pass or
 *     fail because its premise is false. A "probe" writes a table to the OS temp
 *     dir and asserts nothing.
 *
 * Fixtures are built once per describe in beforeAll, so the temp dirs are removed
 * in one afterAll (they must outlive the single test that reads them).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Node as TsNode } from 'web-tree-sitter';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { changedFiles, type ChangedFile } from '../../../src/extensions/queries/blast/diff';
import { grepIndex } from '../../../src/extensions/queries/grep/grep-core';
import { runOrphans } from '../../../src/extensions/queries/orphans/index';
import {
  findOrphans, type GuessedEntry, type OrphanEntry, type OrphansIO, type OrphansReport,
} from '../../../src/extensions/queries/orphans/orphans';
import { openOrphansStore } from '../../../src/extensions/queries/orphans/store';

/**
 * Flipped on by the review round 1 R1-1 case only: while it is up, `getParser('swift')` is null, so
 * orphans' Swift parse is unavailable (grammarReady false, fileParse null). Off, the hook passes through.
 */
const grammarHooks = vi.hoisted(() => ({ swiftParserOff: false }));

vi.mock('../../../src/extraction/grammars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/extraction/grammars')>();
  return {
    ...actual,
    getParser: (language: Parameters<typeof actual.getParser>[0]) =>
      grammarHooks.swiftParserOff && language === 'swift' ? null : actual.getParser(language),
  };
});

/** The most evidence lines one guessed entry keeps per kind (the contract's EVIDENCE_KEPT; render's JSON cap is the same 20). */
const EVIDENCE_KEPT = 20;
/** How many same-named symbols or failed references the mention and unresolved fixtures hold. */
const MANY = 60;

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

/** `git show <spec>` (the pre-image the orphans check reads), or null when git cannot read it. */
function gitShowOrNull(root: string, spec: string): string | null {
  const res = spawnSync('git', ['show', spec], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
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

interface NodeRow {
  id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number; language: string; qualified_name: string;
}
interface EdgeRow { source: string; target: string; kind: string; line: number | null }
interface UnresolvedRow {
  from_node_id: string; reference_name: string; reference_kind: string; file_path: string; line: number; status: string; name_tail: string; language: string;
}
interface IndexRows { nodes: NodeRow[]; edges: EdgeRow[]; unresolved: UnresolvedRow[] }

/** The index's symbols, edges and unresolved references, read once per fixture. */
function indexRows(root: string): IndexRows {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    return {
      nodes: db.prepare(
        "SELECT id, name, kind, file_path, start_line, end_line, language, qualified_name FROM nodes WHERE kind NOT IN ('file','import','parameter')",
      ).all() as unknown as NodeRow[],
      edges: db.prepare('SELECT source, target, kind, line FROM edges').all() as unknown as EdgeRow[],
      unresolved: db.prepare(
        'SELECT from_node_id, reference_name, reference_kind, file_path, line, status, name_tail, language FROM unresolved_refs',
      ).all() as unknown as UnresolvedRow[],
    };
  } finally {
    conn.close();
  }
}

const byName = (ix: IndexRows, name: string, file?: string): NodeRow[] =>
  ix.nodes.filter((n) => n.name === name && (file === undefined || n.file_path === file));
const incomingUses = (ix: IndexRows, id: string): EdgeRow[] =>
  ix.edges.filter((e) => e.target === id && e.kind !== 'contains' && e.kind !== 'exports');
const failedNamed = (ix: IndexRows, tail: string): UnresolvedRow[] =>
  ix.unresolved.filter((u) => u.status === 'failed' && u.name_tail === tail);

/**
 * The text-mention search these cases use: grep-by-symbol's grepIndex over the indexed files, its
 * kept hits flattened. runOrphans wires searchIndexText instead, which keeps the same hits (the
 * O-11 cases in orphans-inherited-run.test.ts pin that).
 */
function ioFor(root: string): OrphansIO {
  return {
    preImage: (file: ChangedFile) => gitShowOrNull(root, `C1:./${file.oldPath ?? file.path}`),
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

/** What one findOrphans call returned, or the message it threw: a throw is a finding the case asserts against. */
interface Outcome { report: OrphansReport | null; error: string | null }

/**
 * findOrphans over the C1 merge-base-to-working-tree files of `root` that `only` admits (all by default), or over
 * `files` when given (a synthetic ChangedFile, for the failed-patch-pass case).
 */
async function orphansOf(
  root: string,
  only: (p: string) => boolean = () => true,
  files?: ChangedFile[],
): Promise<Outcome> {
  const diff = changedFiles(root, 'C1');
  if (!diff) throw new Error('fixture: no diff against C1');
  const chosen = files ?? diff.files.filter((f) => only(f.path));
  const store = openOrphansStore(root);
  try {
    return { report: await findOrphans(store, chosen, ioFor(root)), error: null };
  } catch (err) {
    return { report: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  } finally {
    store.close();
  }
}

/** The case's report; fails the test with the thrown message when findOrphans threw. */
function reportOf(o: Outcome): OrphansReport {
  expect(o.error, 'findOrphans threw').toBeNull();
  return o.report as OrphansReport;
}
const listed = (r: OrphansReport): OrphanEntry[] => [...r.orphans, ...r.guessed];
/** `path:name` of every listed symbol, orphaned or guessed. */
const keysOf = (r: OrphansReport): string[] => listed(r).map((e) => `${e.path}:${e.name}`);
const guessedRuns = (o: Outcome, name: string): GuessedEntry[] => reportOf(o).guessed.filter((e) => e.name === name);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// =====================================================================================
// O-01 mention evidence: MANY same-named methods that nothing calls.
// =====================================================================================

const M_C1 = { 'src/base.ts': 'export const base = 0;\n' };
const M_MANY = `${Array.from({ length: MANY }, (_, i) => `class C${i + 1} { run() {} }`).join('\n')}\n`;

describe('O-01 mention evidence: 60 same-named methods that nothing calls', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let text = { exitCode: -1, output: '' };
  let json = { exitCode: -1, output: '' };

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-mentions-', M_C1, (r) => write(r, 'src/many.ts', M_MANY));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === 'src/many.ts');
    text = await runOrphans(root, { base: 'C1', format: 'text' });
    json = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  it('O-01 fixture: 60 run methods in src/many.ts, none with an incoming use', () => {
    const runs = byName(ix, 'run', 'src/many.ts');
    expect(runs).toHaveLength(MANY);
    expect(runs.filter((n) => incomingUses(ix, n.id).length > 0)).toEqual([]);
  });

  it('O-01: a guessed run entry keeps at most 20 mention lines', () => {
    const runs = guessedRuns(outcome, 'run');
    expect(runs).toHaveLength(MANY);
    expect(Math.max(...runs.map((e) => e.mentions.length))).toBeLessThanOrEqual(EVIDENCE_KEPT);
  });

  it('O-01: the mention lines kept across all run entries stay within 60 x 20', () => {
    const kept = guessedRuns(outcome, 'run').reduce((sum, e) => sum + e.mentions.length, 0);
    expect(kept).toBeLessThanOrEqual(MANY * EVIDENCE_KEPT);
  });

  it('O-01: mentionCount keeps the full count, the 59 other lines, for every run entry', () => {
    expect(guessedRuns(outcome, 'run').map((e) => e.mentionCount)).toEqual(Array(MANY).fill(MANY - 1));
  });

  it('O-01: a run entry keeps its mention lines in path then line order', () => {
    const e = guessedRuns(outcome, 'run').find((x) => x.span === 'L5-L5');
    expect(e).toBeDefined();
    const at = e!.mentions.map((m) => m.line);
    expect(e!.mentions.every((m) => m.path === 'src/many.ts')).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('O-01 pin: the text report prints 3 mention lines, then "+56 more", for a run entry', () => {
    expect(text.exitCode).toBe(0);
    const lines = text.output.split('\n');
    const at = lines.findIndex((l) => /^  src\/many\.ts:5-5  \w+  run$/.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    const ev = lines.slice(at + 1, at + 5);
    expect(ev[0]).toMatch(/^\s+mention\s+src\/many\.ts:1$/);
    expect(ev[1]).toMatch(/^\s+mention\s+src\/many\.ts:2$/);
    expect(ev[2]).toMatch(/^\s+mention\s+src\/many\.ts:3$/);
    expect(ev[3]).toMatch(/^\s+mention\s+\+56 more$/);
  });

  it('O-01 pin: the JSON report keeps 20 mention lines and the full count of 59 for a run entry', () => {
    expect(json.exitCode).toBe(0);
    const r = JSON.parse(json.output) as { guessed: GuessedEntry[] };
    const e = r.guessed.find((x) => x.name === 'run' && x.span === 'L5-L5');
    expect(e?.mentions).toHaveLength(EVIDENCE_KEPT);
    expect(e?.mentionCount).toBe(MANY - 1);
  });
});

// =====================================================================================
// O-01 unresolved evidence: MANY failed Rust references to one name, in another file.
// =====================================================================================

const U_C1 = {
  'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
  'a/Cargo.toml': '[package]\nname = "a_crate"\nversion = "0.1.0"\nedition = "2021"\n',
  'a/src/lib.rs': 'pub fn existing_a() -> u32 {\n    1\n}\n',
  'b/Cargo.toml': '[package]\nname = "b_crate"\nversion = "0.1.0"\nedition = "2021"\n',
};
/** `other_crate` is named by no crate, so each call stays a FAILED reference (the same shape the evidence suite pins). */
const U_C2 = {
  'a/src/cross.rs': 'pub fn cross_target() -> u32 {\n    2\n}\n',
  'b/src/many.rs': Array.from(
    { length: MANY },
    (_, i) => `pub fn drive_${i + 1}() -> u32 {\n    other_crate::cross_target()\n}\n`,
  ).join('\n'),
};

describe('O-01 unresolved evidence: 60 failed references to one name, in another file', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let text = { exitCode: -1, output: '' };
  let json = { exitCode: -1, output: '' };

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-unresolved-', U_C1, (r) => writeAll(r, U_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
    text = await runOrphans(root, { base: 'C1', format: 'text' });
    json = await runOrphans(root, { base: 'C1', format: 'json' });
  }, 60_000);

  const cross = (o: Outcome): GuessedEntry | undefined => reportOf(o).guessed.find((e) => e.name === 'cross_target');

  it('O-01 fixture: cross_target has 60 failed references, one from each drive_k in b/src/many.rs, and no incoming edge', () => {
    const c = byName(ix, 'cross_target', 'a/src/cross.rs');
    expect(c).toHaveLength(1);
    expect(incomingUses(ix, c[0]!.id)).toEqual([]);
    const rows = failedNamed(ix, 'cross_target');
    expect(rows).toHaveLength(MANY);
    expect(rows.every((u) => u.file_path === 'b/src/many.rs')).toBe(true);
  });

  it('O-01: a guessed cross_target keeps at most 20 unresolved references', () => {
    const g = cross(outcome);
    expect(g).toBeDefined();
    expect(g!.unresolved.length).toBeLessThanOrEqual(EVIDENCE_KEPT);
  });

  it('O-01: unresolvedCount keeps the full count of 60', () => {
    expect(cross(outcome)?.unresolvedCount).toBe(MANY);
  });

  it('O-01: the kept unresolved references are the first 20 by path then line', () => {
    const all = failedNamed(ix, 'cross_target')
      .map((u): [string, number] => [u.file_path, u.line])
      .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
    const g = cross(outcome);
    expect(g?.unresolved.map((u): [string, number] => [u.path, u.line])).toEqual(all.slice(0, EVIDENCE_KEPT));
  });

  it('O-01 pin: the text report prints 3 unresolved lines, then "+57 more", for cross_target', () => {
    expect(text.exitCode).toBe(0);
    const lines = text.output.split('\n');
    const at = lines.findIndex((l) => /^  a\/src\/cross\.rs:1-3  \w+  cross_target$/.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    const ev = lines.slice(at + 1, at + 5);
    for (const l of ev.slice(0, 3)) {
      expect(l).toMatch(/^\s+unresolved\s+← calls other_crate::cross_target\s+b\/src\/many\.rs:\d+$/);
    }
    expect(ev[3]).toMatch(/^\s+unresolved\s+\+57 more$/);
  });

  it('O-01 pin: the JSON report keeps 20 unresolved references and the full count of 60', () => {
    expect(json.exitCode).toBe(0);
    const r = JSON.parse(json.output) as { guessed: GuessedEntry[] };
    const e = r.guessed.find((x) => x.name === 'cross_target');
    expect(e?.unresolved).toHaveLength(EVIDENCE_KEPT);
    expect(e?.unresolvedCount).toBe(MANY);
  });
});

// =====================================================================================
// O-05 / O-08 / O-09 attributes and O-06 requirements, Rust and Swift.
// One fixture repo; every changed file is read in one findOrphans run.
// =====================================================================================

const R_C1 = {
  'Cargo.toml': '[package]\nname = "attrs"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn existing() -> u32 {\n    1\n}\n',
  'Sources/Attrs/Seed.swift': 'func seedSwift() -> Int {\n    return 1\n}\n',
};

const R_C2: Record<string, string> = {
  // O-05: attributes are read from the parse tree, not from the text of the line.
  // a_one_liner is a one-line fn with its #[test] on that same line; b_after_oneliner is the line after it (A11).
  'src/attrs.rs': [
    'pub fn production() { let message = "#[test]"; }',
    '',
    'pub fn trailing() {} // #[test]',
    '',
    '#[test] fn a_one_liner() {}',
    'fn b_after_oneliner() {}',
    '',
    '#[test]',
    'fn t1() {}',
    '',
    '#[tokio::test]',
    'async fn t2() {}',
    '',
    '#[rstest]',
    'fn t3() {}',
    '',
    '// #[test]',
    'fn commented_line_only() {}',
    '',
    '/// #[test]',
    'fn commented_doc_only() {}',
    '',
  ].join('\n'),
  // O-08: a multi-line attribute.
  'src/multiline.rs': '#[tokio::test(\n    flavor = "multi_thread"\n)]\nasync fn smoke() {}\n',
  // O-09: #[cfg(test ...)] with a comment inside its argument list, and the plain form.
  'src/cfg.rs': [
    '#[cfg(test /* unit tests */)]',
    'mod checks {',
    '    fn helper() {}',
    '}',
    '',
    '#[cfg(/* c */ test)]',
    'mod checks2 {',
    '    fn helper2() {}',
    '}',
    '',
    '#[cfg(test)]',
    'mod plain {',
    '    fn plain_helper() {}',
    '}',
    '',
  ].join('\n'),
  // O-06 pin: a Rust trait method and its impl.
  'src/speak.rs': 'pub trait Speak {\n    fn speak_now(&self);\n}\n\npub struct Mouth;\n\nimpl Speak for Mouth {\n    fn speak_now(&self) {}\n}\n',
  // O-05 Swift: "@Test" inside a string, the real attribute, and comment forms.
  'Sources/Attrs/Marks.swift': [
    'func productionSwift() { print("@Test") }',
    '',
    '@Test func swiftTestReal() {}',
    '',
    '@Test',
    'func swiftTestSeparate() {}',
    '',
    '// @Test',
    'func swiftLineCommentMarks() {}',
    '',
  ].join('\n'),
  // O-06 pin: a Swift @main type and its static main.
  'Sources/Attrs/App.swift': '@main struct App { static func main() {} }\n',
  // O-06 pin: a Swift protocol requirement excludes the conforming method.
  'Sources/Attrs/Proto.swift': 'protocol Serving {\n    func serve()\n}\n\nstruct Server: Serving {\n    func serve() {}\n}\n',
  // O-06 Swift: a protocol holding only a comment that names stop.
  'Sources/Attrs/Stop.swift': 'protocol Stopping {\n    // stop later\n}\n\nstruct Stopper: Stopping {\n    func stop() {}\n}\n',
};

/** The symbols the attribute fixture must index, so every verdict below is about a real node. */
const R_NODES: readonly (readonly [string, string])[] = [
  ['production', 'src/attrs.rs'], ['trailing', 'src/attrs.rs'], ['a_one_liner', 'src/attrs.rs'],
  ['b_after_oneliner', 'src/attrs.rs'], ['t1', 'src/attrs.rs'], ['t2', 'src/attrs.rs'], ['t3', 'src/attrs.rs'],
  ['commented_line_only', 'src/attrs.rs'], ['commented_doc_only', 'src/attrs.rs'], ['smoke', 'src/multiline.rs'],
  ['helper', 'src/cfg.rs'], ['helper2', 'src/cfg.rs'], ['plain_helper', 'src/cfg.rs'], ['speak_now', 'src/speak.rs'],
  ['productionSwift', 'Sources/Attrs/Marks.swift'], ['swiftTestReal', 'Sources/Attrs/Marks.swift'],
  ['swiftTestSeparate', 'Sources/Attrs/Marks.swift'], ['swiftLineCommentMarks', 'Sources/Attrs/Marks.swift'],
  ['App', 'Sources/Attrs/App.swift'], ['main', 'Sources/Attrs/App.swift'], ['serve', 'Sources/Attrs/Proto.swift'],
  ['Server', 'Sources/Attrs/Proto.swift'], ['stop', 'Sources/Attrs/Stop.swift'], ['Stopper', 'Sources/Attrs/Stop.swift'],
];

describe('O-05 / O-08 / O-09 / O-06 Rust and Swift: attributes, comments and requirements', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-attrs-', R_C1, (r) => writeAll(r, R_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('O-05 fixture: every symbol of the attribute fixture is an indexed node in its file', () => {
    const missing = R_NODES.filter(([name, file]) => byName(ix, name, file).length === 0).map(([n, f]) => `${f}:${n}`);
    expect(missing).toEqual([]);
  });

  it('O-05: pub fn production, whose line holds "#[test]" in a string, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:production');
  });

  it('O-05: pub fn trailing, with a trailing "// #[test]" comment, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:trailing');
  });

  it('O-05 A11: fn b_after_oneliner, on the line after a one-line #[test] fn, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('src/attrs.rs:b_after_oneliner');
  });

  it('O-05 A11 pin: the one-line #[test] fn a_one_liner itself is excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/attrs.rs:a_one_liner');
  });

  it('O-05: func productionSwift, whose line holds "@Test" in a string, is listed, not excluded as a test', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Marks.swift:productionSwift');
  });

  it('O-05 pin: a #[test] on its own line above a fn excludes it (t1)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/attrs.rs:t1');
  });

  it('O-05 pin: #[tokio::test] and #[rstest] above a fn exclude it (t2, t3)', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).not.toContain('src/attrs.rs:t2');
    expect(keys).not.toContain('src/attrs.rs:t3');
  });

  it('O-05 pin: a // #[test] line comment and a /// #[test] doc comment above a fn mark nothing', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).toContain('src/attrs.rs:commented_line_only');
    expect(keys).toContain('src/attrs.rs:commented_doc_only');
  });

  it('O-05 pin: a Swift @Test func and a @Test on its own line above a func exclude it', () => {
    const keys = keysOf(reportOf(outcome));
    expect(keys).not.toContain('Sources/Attrs/Marks.swift:swiftTestReal');
    expect(keys).not.toContain('Sources/Attrs/Marks.swift:swiftTestSeparate');
  });

  it('O-05 pin: a Swift // @Test line comment above a func marks nothing', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Marks.swift:swiftLineCommentMarks');
  });

  it('O-08: a multi-line #[tokio::test(...)] attribute still excludes smoke as a test', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/multiline.rs:smoke');
  });

  it('O-09: a fn in #[cfg(test /* unit tests */)] mod checks is excluded as a test (helper)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:helper');
  });

  it('O-09: a fn in #[cfg(/* c */ test)] mod checks2 is excluded as a test (helper2)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:helper2');
  });

  it('O-09 pin: a fn in a plain #[cfg(test)] mod is still excluded as a test (plain_helper)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/cfg.rs:plain_helper');
  });

  it('O-06 pin: a @main struct App and its static main are excluded as entry points', () => {
    const r = reportOf(outcome);
    const keys = keysOf(r);
    expect(keys).not.toContain('Sources/Attrs/App.swift:App');
    expect(keys).not.toContain('Sources/Attrs/App.swift:main');
    expect(r.excluded.entry).toBeGreaterThanOrEqual(2);
  });

  it('O-06 pin: a Rust trait method and its impl (Speak.speak_now, Mouth.speak_now) are excluded as implementations', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('src/speak.rs:speak_now');
  });

  it('O-06 pin: a Swift protocol requirement excludes the conforming struct\'s method (Server.serve)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Attrs/Proto.swift:serve');
  });

  it('O-06 Swift: a protocol whose body is only a comment naming stop does not exclude the struct\'s stop()', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Attrs/Stop.swift:stop');
  });
});

// =====================================================================================
// O-02 external bases, O-03 same-line siblings, O-06 comment-only bases and TypeScript
// interfaces, and the recursion pin. TypeScript.
// =====================================================================================

const C_C1 = { 'src/base.ts': 'export class Base {\n  // run once the API is ready\n}\n' };
const C_C2: Record<string, string> = {
  // O-06 TS: a class whose base holds only a comment that names run.
  'src/derived.ts': "import { Base } from './base';\n\nexport class Derived extends Base { run() {} }\n",
  // O-06 pin: a TS interface member and its implementation.
  'src/iface.ts': 'export interface IRunner {\n  exec(): void;\n}\n\nexport class ImplRunner implements IRunner {\n  exec() {}\n}\n',
  // O-02: an external base whose name is an Object.prototype property (constructor, toString, hasOwnProperty).
  'src/extra-ctor.ts': "import { constructor } from 'external-pkg';\n\nexport class ExtraCtor extends constructor {\n  workCtor() {}\n}\n",
  'src/extra-str.ts': "import { toString } from 'external-pkg';\n\nexport class ExtraStr extends toString {\n  workStr() {}\n}\n",
  'src/extra-own.ts': "import { hasOwnProperty } from 'external-pkg';\n\nexport class ExtraOwn extends hasOwnProperty {\n  workOwn() {}\n}\n",
  // O-03: caller and target on one line; the call from caller is target's only use.
  'src/same-line.ts': 'export function caller() { return target(); } export function target() { return 1; }\n',
  'src/use-same.ts': "import { caller } from './same-line';\n\nexport function driver(): number {\n  return caller();\n}\n",
  // O-03 pin: a recursive call from a nested closure inside the function's own span.
  'src/recur.ts': 'export function pinRecurse(n: number): number {\n  const again = (): number => pinRecurse(n - 1);\n  return n > 0 ? again() : 0;\n}\n',
};
/** The files the main TypeScript run reads (the O-02 files each run on their own, since one throw ends the run). */
const C_MAIN = ['src/derived.ts', 'src/iface.ts', 'src/same-line.ts', 'src/use-same.ts', 'src/recur.ts'];

describe('O-02 / O-03 / O-06 TypeScript: external bases, same-line siblings, comment-only bases, interfaces, recursion', () => {
  let root = '';
  let ix: IndexRows;
  let main: Outcome;
  let ctor: Outcome;
  let str: Outcome;
  let own: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-ts-', C_C1, (r) => writeAll(r, C_C2));
    ix = indexRows(root);
    main = await orphansOf(root, (p) => C_MAIN.includes(p));
    ctor = await orphansOf(root, (p) => p === 'src/extra-ctor.ts');
    str = await orphansOf(root, (p) => p === 'src/extra-str.ts');
    own = await orphansOf(root, (p) => p === 'src/extra-own.ts');
  }, 60_000);

  it('O-02 fixture: each extra class holds a failed reference to its external base, and its method is a node', () => {
    const want: [string, string, string, string][] = [
      ['ExtraCtor', 'constructor', 'workCtor', 'src/extra-ctor.ts'],
      ['ExtraStr', 'toString', 'workStr', 'src/extra-str.ts'],
      ['ExtraOwn', 'hasOwnProperty', 'workOwn', 'src/extra-own.ts'],
    ];
    const missing = want
      .filter(([cls, base, method, file]) => {
        const c = byName(ix, cls, file)[0];
        return !c || byName(ix, method, file).length === 0 || !ix.unresolved.some((u) => u.from_node_id === c.id && u.reference_name === base);
      })
      .map(([cls, base, method]) => `${cls} extends ${base} / ${method}`);
    expect(missing).toEqual([]);
  });

  it('O-02: findOrphans does not throw on a class extending constructor', () => {
    reportOf(ctor);
  });

  it('O-02: ExtraCtor.workCtor is listed with constructor as its external conformance', () => {
    const e = listed(reportOf(ctor)).find((x) => x.name === 'workCtor');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('constructor');
  });

  it('O-02: findOrphans does not throw on a class extending toString', () => {
    reportOf(str);
  });

  it('O-02: ExtraStr.workStr is listed with toString as its external conformance', () => {
    const e = listed(reportOf(str)).find((x) => x.name === 'workStr');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('toString');
  });

  it('O-02: findOrphans does not throw on a class extending hasOwnProperty', () => {
    reportOf(own);
  });

  it('O-02: ExtraOwn.workOwn is listed with hasOwnProperty as its external conformance', () => {
    const e = listed(reportOf(own)).find((x) => x.name === 'workOwn');
    expect(e).toBeDefined();
    expect(e?.externalConformances).toContain('hasOwnProperty');
  });

  it('O-03 fixture: caller and target are both on line 1 of src/same-line.ts, with a calls edge from caller to target', () => {
    const target = byName(ix, 'target', 'src/same-line.ts');
    const caller = byName(ix, 'caller', 'src/same-line.ts');
    expect(target).toHaveLength(1);
    expect(caller).toHaveLength(1);
    expect([target[0]!.start_line, target[0]!.end_line, caller[0]!.start_line, caller[0]!.end_line]).toEqual([1, 1, 1, 1]);
    expect(ix.edges.some((e) => e.kind === 'calls' && e.source === caller[0]!.id && e.target === target[0]!.id)).toBe(true);
  });

  it('O-06 TS fixture: ImplRunner.exec is a node at line 6 of src/iface.ts, so the interface pin is about a real symbol', () => {
    expect(ix.nodes.some((n) => n.name === 'exec' && n.file_path === 'src/iface.ts' && n.start_line === 6)).toBe(true);
  });

  it('O-03: target, called by its one-line sibling caller, is neither orphaned nor guessed', () => {
    expect(keysOf(reportOf(main))).not.toContain('src/same-line.ts:target');
  });

  it('O-03 pin: pinRecurse, used only from a nested closure inside its own span, stays an orphan', () => {
    const r = reportOf(main);
    expect(r.orphans.map((e) => `${e.path}:${e.name}`)).toContain('src/recur.ts:pinRecurse');
    expect(r.guessed.map((e) => `${e.path}:${e.name}`)).not.toContain('src/recur.ts:pinRecurse');
  });

  it('O-06 TS: Derived.run is listed, not excluded as implementing a base whose only comment names run', () => {
    expect(keysOf(reportOf(main))).toContain('src/derived.ts:run');
  });

  it('O-06 TS pin: ImplRunner.exec, implementing IRunner, is excluded as an implementation', () => {
    expect(keysOf(reportOf(main))).not.toContain('src/iface.ts:exec');
  });
});

// =====================================================================================
// O-07 Swift full type path: the red case, alone, so no other Widget or encode is near it.
// =====================================================================================

const S1_C1 = { 'Sources/Pkg/A.swift': 'enum A {\n    struct Widget: Encodable {}\n}\n' };
const S1_C2 = { 'Sources/Pkg/B.swift': 'enum B {\n    struct Widget {\n        func encode() {}\n    }\n}\n' };

describe('O-07 Swift nested types: B.Widget.encode is not Encodable\'s implementation', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-swift-nested-', S1_C1, (r) => writeAll(r, S1_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('O-07 fixture: A.swift nests a Widget with an unresolved Encodable conformance; B.swift nests an encode in a Widget', () => {
    const wa = byName(ix, 'Widget', 'Sources/Pkg/A.swift');
    expect(wa).toHaveLength(1);
    expect(ix.unresolved.some((u) => u.from_node_id === wa[0]!.id && u.reference_name === 'Encodable')).toBe(true);
    const enc = byName(ix, 'encode', 'Sources/Pkg/B.swift');
    expect(enc).toHaveLength(1);
    const parent = ix.edges.find((e) => e.kind === 'contains' && e.target === enc[0]!.id);
    const holder = ix.nodes.find((n) => n.id === parent?.source);
    expect(holder?.name).toBe('Widget');
    expect(holder?.file_path).toBe('Sources/Pkg/B.swift');
  });

  it('O-07: B.Widget.encode is listed, not excluded as an Encodable implementation', () => {
    expect(keysOf(reportOf(outcome))).toContain('Sources/Pkg/B.swift:encode');
  });
});

// =====================================================================================
// O-07 Swift extensions: the pins, and the probe that records the index's names.
// =====================================================================================

const S2_C1 = { 'Sources/Pkg/Seed.swift': 'func seedFn() -> Int {\n    return 1\n}\n' };
const S2_C2 = {
  'Sources/Pkg/Widget.swift': 'struct Widget {}\n\nextension Widget: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n',
  'Sources/Pkg/Keys.swift': 'enum K {\n    struct Builder {}\n}\n\nextension K.Builder: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n',
};

describe('O-07 Swift extensions: the pins and the qualified-name probe', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-swift-ext-', S2_C1, (r) => writeAll(r, S2_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root);
  }, 60_000);

  it('O-07 fixture: encode is a node in Widget.swift and in Keys.swift', () => {
    expect(byName(ix, 'encode', 'Sources/Pkg/Widget.swift')).toHaveLength(1);
    expect(byName(ix, 'encode', 'Sources/Pkg/Keys.swift')).toHaveLength(1);
  });

  it('O-07 pin: encode in extension Widget (of top-level struct Widget) is excluded as an implementation', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Pkg/Widget.swift:encode');
  });

  it('O-07 pin: encode in extension K.Builder (of nested K.Builder) is excluded as an implementation', () => {
    expect(keysOf(reportOf(outcome))).not.toContain('Sources/Pkg/Keys.swift:encode');
  });

  it('O-07 probe: the names the index gives nested types and extension K.Builder (writes a table, asserts nothing)', () => {
    const rows = ix.nodes.filter((n) => ['Widget', 'Builder', 'K', 'encode'].includes(n.name));
    const table = rows.map((n) => `${n.file_path}  ${n.kind}  name=${n.name}  qualified_name=${n.qualified_name}`).join('\n');
    fs.writeFileSync(path.join(os.tmpdir(), 'cg-orphans-core-o07-probe.txt'), `${table}\n`);
  });
});

// =====================================================================================
// O-10 ranges: a .ts file git diffs as binary, a pure rename, a mode-only change, and a
// modified file whose changed-line ranges are empty.
// =====================================================================================

const G_C1: Record<string, string> = {
  '.gitattributes': '*.ts -diff\n',
  'src/ts-diffless.ts': 'export function existingOne(): number {\n  return 1;\n}\n',
  'src/renamed-old.ts': 'export function movedFn(): number {\n  return 2;\n}\n',
  'src/mode.ts': 'export function modeFn(): number {\n  return 3;\n}\n',
};

describe('O-10 ranges: a binary-diffed file, a rename, a mode-only change, and a file with no ranges', () => {
  let root = '';
  let ix: IndexRows;
  let files: ChangedFile[] = [];
  let gMain: Outcome;
  let gSynth: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-core-ranges-', G_C1, (r) => {
      fs.appendFileSync(path.join(r, 'src/ts-diffless.ts'), '\nexport function addedLater() {}\n');
      fs.renameSync(path.join(r, 'src/renamed-old.ts'), path.join(r, 'src/renamed-new.ts'));
      // A mode-only change is in the diff only where git tracks the executable bit. A Windows checkout
      // sets core.filemode=false, so there the chmod is no change and mode.ts is not in the diff.
      if (process.platform !== 'win32') fs.chmodSync(path.join(r, 'src/mode.ts'), 0o755);
    });
    ix = indexRows(root);
    files = changedFiles(root, 'C1')?.files ?? [];
    gMain = await orphansOf(root);
    // The failed-patch-pass shape: a modified file with no ranges, read straight into findOrphans.
    gSynth = await orphansOf(root, undefined, [{ path: 'src/ts-diffless.ts', status: 'modified', ranges: [], hunks: [] }]);
  }, 60_000);

  it('O-10 fixture: git gives ts-diffless.ts no ranges, renamed-new.ts as a rename of renamed-old.ts, and addedLater is indexed', () => {
    const at = (p: string): ChangedFile | undefined => files.find((f) => f.path === p);
    expect(at('src/ts-diffless.ts')).toMatchObject({ status: 'modified', ranges: [] });
    expect(at('src/renamed-new.ts')).toMatchObject({ status: 'renamed', oldPath: 'src/renamed-old.ts', ranges: [] });
    expect(byName(ix, 'addedLater', 'src/ts-diffless.ts')).toHaveLength(1);
    // The pins below are about these symbols: each must be an indexed node, or its pin is empty.
    expect(byName(ix, 'movedFn', 'src/renamed-new.ts')).toHaveLength(1);
    expect(byName(ix, 'modeFn', 'src/mode.ts')).toHaveLength(1);
    expect(byName(ix, 'existingOne', 'src/ts-diffless.ts')).toHaveLength(1);
  });

  it('O-10: addedLater, appended to a .ts file that git diffs as binary, is listed', () => {
    expect(keysOf(reportOf(gMain))).toContain('src/ts-diffless.ts:addedLater');
  });

  it('O-10 pin: a pure rename (R100) of a file with symbols adds nothing (movedFn)', () => {
    expect(keysOf(reportOf(gMain))).not.toContain('src/renamed-new.ts:movedFn');
  });

  it.runIf(process.platform !== 'win32')('O-10 fixture: git gives mode.ts no ranges (a mode-only change, posix only)', () => {
    const at = (p: string): ChangedFile | undefined => files.find((f) => f.path === p);
    expect(at('src/mode.ts')).toMatchObject({ status: 'modified', ranges: [] });
  });

  it.runIf(process.platform !== 'win32')('O-10 pin: a mode-only change (chmod +x) adds nothing (modeFn)', () => {
    expect(keysOf(reportOf(gMain))).not.toContain('src/mode.ts:modeFn');
  });

  it('O-10: a modified file with no ranges lists the function its pre-image lacks (addedLater)', () => {
    expect(keysOf(reportOf(gSynth))).toContain('src/ts-diffless.ts:addedLater');
  });

  it('O-10 pin: a function whose name the pre-image holds (existingOne) is not listed', () => {
    expect(keysOf(reportOf(gSynth))).not.toContain('src/ts-diffless.ts:existingOne');
  });
});

// =====================================================================================
// O-06 probe: interface and abstract members in other languages. Writes the table, asserts
// nothing. The table was to decide which languages keep the span-text fallback; the round-1
// rework (R1-1) removed that fallback from the orphans check.
// =====================================================================================

const P_FILES: Record<string, string> = {
  'probe/Iface.java': 'public interface IProbeJava {\n    void probeJava();\n}\n\nabstract class AbsProbeJava {\n    abstract void absJava();\n}\n',
  'probe/IProbeCs.cs': 'public interface IProbeCs {\n    void ProbeCs();\n}\n',
  'probe/iface.kt': 'interface IProbeKt {\n    fun probeKt()\n}\n',
  'probe/iface.php': '<?php\ninterface IProbePhp {\n    public function probePhp();\n}\n',
  'probe/iface.go': 'package probe\n\ntype IProbeGo interface {\n\tProbeGo()\n}\n',
  'probe/iface.py': 'from abc import ABC, abstractmethod\n\n\nclass IProbePy(ABC):\n    @abstractmethod\n    def probe_py(self):\n        pass\n',
};
const P_MEMBERS = ['probeJava', 'absJava', 'ProbeCs', 'probeKt', 'probePhp', 'ProbeGo', 'probe_py'];

describe('O-06 probe: is an interface or abstract member an indexed node held by its type?', () => {
  let ix: IndexRows;

  beforeAll(async () => {
    const root = await fixtureRepo('cg-orphans-core-probe-', { 'README.md': '# probe\n' }, (r) => writeAll(r, P_FILES));
    ix = indexRows(root);
  }, 60_000);

  it('O-06 probe: writes, per member, the node kind and the container that holds it (asserts nothing)', () => {
    const lines = P_MEMBERS.map((member) => {
      const ns = byName(ix, member);
      if (ns.length === 0) return `${member}: no node`;
      return ns.map((n) => {
        const holders = ix.edges
          .filter((e) => e.kind === 'contains' && e.target === n.id)
          .map((e) => ix.nodes.find((p) => p.id === e.source));
        const held = holders.map((p) => (p ? `${p.kind} ${p.name}` : 'unknown')).join(', ') || 'no container';
        return `${member}: ${n.file_path} node kind=${n.kind}; held by ${held}`;
      }).join('\n');
    });
    fs.writeFileSync(path.join(os.tmpdir(), 'cg-orphans-core-o06-probe.txt'), `${lines.join('\n')}\n`);
  });
});

// =====================================================================================
// Review round 1: the change reviewer's FAIL on the orphans-core diff, one describe per
// finding (R1-1 to R1-7 here; R1-8 is in orphans-inherited-run.test.ts). Each describe builds
// its own fixture in beforeAll. A case named "control" or "pin" passes both before and after the
// round-1 rework (9cecf610; its parent a6c997c0 is the code before it) and must keep passing.
// Every other case was red before the rework, at an assertion, and passes now. R1-3 is a pin
// rather than fail-first: it was green before the rework too. The probes write a table to the
// OS temp dir and assert nothing.
// =====================================================================================

/**
 * The index's nodes of `files` with their line and column spans and qualified names, and every edge
 * touching them, by name (the facts a fix needs: columns, contains edges, path strings). Asserts nothing.
 */
function writeNodeProbe(root: string, files: readonly string[], outName: string): void {
  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    const marks = files.map(() => '?').join(', ');
    const nodes = db.prepare(
      `SELECT id, name, kind, file_path, start_line, end_line, start_column, end_column, qualified_name
         FROM nodes WHERE file_path IN (${marks}) AND kind NOT IN ('file', 'import', 'parameter')
         ORDER BY file_path, start_line, start_column`,
    ).all(...files) as unknown as {
      id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number;
      start_column: number; end_column: number; qualified_name: string;
    }[];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (db.prepare('SELECT source, target, kind, line FROM edges').all() as unknown as EdgeRow[])
      .filter((e) => byId.has(e.source) || byId.has(e.target));
    const label = (id: string): string => {
      const n = byId.get(id);
      return n ? `${n.name}@L${n.start_line}C${n.start_column}` : id;
    };
    const out = [
      ...nodes.map((n) => `${n.file_path}  ${n.kind}  ${n.name}  L${n.start_line}-L${n.end_line}  C${n.start_column}-C${n.end_column}  qualified=${n.qualified_name}`),
      ...edges.map((e) => `edge ${e.kind}: ${label(e.source)} -> ${label(e.target)}  line=${e.line ?? 'none'}`),
    ];
    fs.writeFileSync(path.join(os.tmpdir(), outName), `${out.join('\n')}\n`);
  } finally {
    conn.close();
  }
}

// --- R1-1 (O-06): a protocol whose parse is unavailable proves no requirement by a comment -------

const STOP_FILE = 'Sources/Pkg/Stop.swift';
const PROTO_C1: Record<string, string> = { 'Sources/Pkg/Seed.swift': 'func seedStop() -> Int {\n    return 1\n}\n' };
const PROTO_C2: Record<string, string> = {
  // A protocol whose body is only a comment naming stop, and a struct conforming to it with stop().
  [STOP_FILE]: 'protocol Stopping {\n    // stop later\n}\n\nstruct Stopper: Stopping {\n    func stop() {}\n}\n',
};

describe('review round 1 R1-1 (O-06): a Swift protocol whose parse is unavailable proves no requirement by a comment', () => {
  let root = '';
  let ix: IndexRows;
  let withParse: Outcome;
  let withoutParse: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-proto-', PROTO_C1, (r) => writeAll(r, PROTO_C2));
    ix = indexRows(root);
    const onlyStop = (p: string): boolean => p === STOP_FILE;
    // The control: the Swift parse runs, and the protocol's parsed requirement set has no stop.
    withParse = await orphansOf(root, onlyStop);
    // The forced path: getParser('swift') is null for this one findOrphans call. grammarReady is false, fileParse
    // is null, and protocolRequirements returns null. Before the round-1 rework the check fell back to spanMentions,
    // which read the comment and so proved stop required; now an unavailable parse proves nothing, and stop is listed.
    grammarHooks.swiftParserOff = true;
    try {
      withoutParse = await orphansOf(root, onlyStop);
    } finally {
      grammarHooks.swiftParserOff = false;
    }
  }, 120_000);

  it('R1-1 fixture: stop and the protocol Stopping are indexed nodes of Stop.swift', () => {
    expect(byName(ix, 'stop', STOP_FILE)).toHaveLength(1);
    expect(byName(ix, 'Stopping', STOP_FILE)).toHaveLength(1);
  });

  it('R1-1 control: with the Swift parse available, stop is listed and no method is excluded as an implementation', () => {
    expect(keysOf(reportOf(withParse))).toContain(`${STOP_FILE}:stop`);
    expect(reportOf(withParse).excluded.implementation).toBe(0);
  });

  it('R1-1: with the Swift parse unavailable, a comment naming stop does not prove it: stop is listed', () => {
    expect(keysOf(reportOf(withoutParse))).toContain(`${STOP_FILE}:stop`);
  });

  it('R1-1: with the Swift parse unavailable, no method is excluded as an implementation', () => {
    expect(reportOf(withoutParse).excluded.implementation).toBe(0);
  });
});

// --- R1-2 (O-07): a same-named Swift type whose full path cannot be read joins no other type ----

describe('review round 1 R1-2 (O-07): a same-named Swift type whose full path cannot be read joins no other type', () => {
  const A_FILE = 'Sources/Pkg/A.swift';
  const B_FILE = 'Sources/Pkg/B.swift';
  let rootA = '';
  let rootB = '';
  let ixA: IndexRows;
  let unknownA: Outcome;
  let unknownB: Outcome;
  /** B.swift's ChangedFile entry, taken while the file is still on disk. */
  let bEntries: ChangedFile[] = [];

  beforeAll(async () => {
    // A's path is unknown: A.swift is indexed, then made unreadable (deleted from the working tree).
    rootA = await fixtureRepo('cg-orphans-review-r1-unknown-a-', S1_C1, (r) => writeAll(r, S1_C2));
    ixA = indexRows(rootA);
    fs.rmSync(path.join(rootA, A_FILE));
    unknownA = await orphansOf(rootA, (p) => p === B_FILE);
    // B's path is unknown: B.swift is indexed, then made unreadable.
    rootB = await fixtureRepo('cg-orphans-review-r1-unknown-b-', S1_C1, (r) => writeAll(r, S1_C2));
    // blast's changedFiles diffs the merge base against the working tree, so once B.swift is gone from
    // disk the diff no longer lists it. B's entry is taken first and passed to findOrphans explicitly.
    bEntries = (changedFiles(rootB, 'C1')?.files ?? []).filter((f) => f.path === B_FILE);
    fs.rmSync(path.join(rootB, B_FILE));
    unknownB = await orphansOf(rootB, () => true, bEntries);
  }, 120_000);

  it('R1-2 fixture: A.Widget holds a failed Encodable reference, and A.swift is gone from the working tree', () => {
    const wa = byName(ixA, 'Widget', A_FILE);
    expect(wa).toHaveLength(1);
    expect(ixA.unresolved.some((u) => u.from_node_id === wa[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
    expect(fs.existsSync(path.join(rootA, A_FILE))).toBe(false);
  });

  it('R1-2 A unknown: B.Widget.encode is not excluded through the unreadable A.Widget (Encodable)', () => {
    expect(keysOf(reportOf(unknownA))).toContain(`${B_FILE}:encode`);
    expect(reportOf(unknownA).excluded.implementation).toBe(0);
  });

  it('R1-2 B unknown: encode in the unreadable B.swift is not excluded through A.Widget (Encodable)', () => {
    expect(bEntries.map((f) => f.status)).toEqual(['added']);
    expect(keysOf(reportOf(unknownB))).toContain(`${B_FILE}:encode`);
    expect(reportOf(unknownB).excluded.implementation).toBe(0);
  });
});

// --- R1-3 (O-03): a failed reference from a same-line sibling is evidence; a failed reference from inside S is not ---

const FAILED_C1: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "oneline"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn seed() -> u32 {\n    1\n}\n',
};
const FAILED_C2: Record<string, string> = {
  // caller and target share line 1; the failed `other_crate::target` comes from caller, the sibling.
  'src/same.rs': 'fn caller() { other_crate::target(); } fn target() {}\n',
  // The control: the one failed reference is from inside own_target's own span.
  'src/own.rs': 'fn own_target() { other_crate::own_target(); }\n',
};

describe('review round 1 R1-3 (O-03): a failed reference from a same-line sibling is evidence for its target', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-failed-', FAILED_C1, (r) => writeAll(r, FAILED_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === 'src/same.rs' || p === 'src/own.rs');
  }, 120_000);

  it('R1-3 fixture: caller and target share line 1 of src/same.rs, and the failed other_crate::target comes from caller', () => {
    const target = byName(ix, 'target', 'src/same.rs');
    const caller = byName(ix, 'caller', 'src/same.rs');
    expect(target).toHaveLength(1);
    expect(caller).toHaveLength(1);
    expect([target[0]!.start_line, target[0]!.end_line, caller[0]!.start_line, caller[0]!.end_line]).toEqual([1, 1, 1, 1]);
    const ref = failedNamed(ix, 'target').find((u) => u.reference_name === 'other_crate::target');
    expect(ref?.from_node_id).toBe(caller[0]!.id);
    expect(incomingUses(ix, target[0]!.id)).toEqual([]);
  });

  it('R1-3: target, whose only reference is the failed call from its one-line sibling, is guessed with that evidence, not orphaned', () => {
    expect(reportOf(outcome).orphans.map((e) => `${e.path}:${e.name}`)).not.toContain('src/same.rs:target');
    const g = guessedRuns(outcome, 'target').find((e) => e.path === 'src/same.rs');
    expect(g).toBeDefined();
    expect(g?.unresolved).toContainEqual({ name: 'other_crate::target', kind: 'calls', path: 'src/same.rs', line: 1 });
  });

  it('R1-3 control: own_target, whose only failed reference is from inside its own span, is excluded and stays orphaned', () => {
    const r = reportOf(outcome);
    expect(r.orphans.map((e) => `${e.path}:${e.name}`)).toContain('src/own.rs:own_target');
    expect(r.guessed.map((e) => `${e.path}:${e.name}`)).not.toContain('src/own.rs:own_target');
  });
});

// --- R1-4 (O-03, Dart): incomplete end columns must not make a nested one-line function a use ---

const DART_FILE = 'lib/lonely.dart';
const DART_C1: Record<string, string> = { 'lib/base.dart': 'int base() => 0;\n' };
const DART_C2: Record<string, string> = {
  // lonely's only use is its nested local function again(), on the same line; again() calls lonely() from inside lonely.
  [DART_FILE]: 'int lonely() { int again() => lonely(); return again(); }\n',
};

describe('review round 1 R1-4 (O-03, Dart): a one-line nested function does not make its enclosing function used', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-dart-', DART_C1, (r) => writeAll(r, DART_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === DART_FILE);
  }, 120_000);

  it('R1-4 fixture: lonely is an indexed node on line 1 of lib/lonely.dart', () => {
    const lonely = byName(ix, 'lonely', DART_FILE);
    expect(lonely).toHaveLength(1);
    expect([lonely[0]!.start_line, lonely[0]!.end_line]).toEqual([1, 1]);
  });

  it('R1-4 probe: writes the Dart nodes with their columns and every edge among them (asserts nothing)', () => {
    writeNodeProbe(root, [DART_FILE], 'cg-orphans-review-r1-dart-probe.txt');
  });

  it('R1-4: lonely, whose only use is the nested again() on the same line, is listed (orphaned or guessed), not treated as used', () => {
    expect(keysOf(reportOf(outcome))).toContain(`${DART_FILE}:lonely`);
  });
});

// --- R1-5 (entry rule, Swift): a composition continuation line must not hide @main ----------

const APP_FILE = 'Sources/Pkg/App.swift';
const AMP_C1: Record<string, string> = { 'Sources/Pkg/Seed.swift': 'func seedApp() -> Int {\n    return 1\n}\n' };
const AMP_C2: Record<string, string> = {
  // An @main type whose body holds a composition type continued on a line that starts with `&`.
  [APP_FILE]: '@main struct App {\n    let handler: Serving\n        & Stopping\n    static func main() {}\n}\n',
};

describe('review round 1 R1-5 (entry rule, Swift): @main and static main survive a composition continuation line', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-swift-amp-', AMP_C1, (r) => writeAll(r, AMP_C2));
    ix = indexRows(root);
    outcome = await orphansOf(root, (p) => p === APP_FILE);
  }, 120_000);

  it('R1-5 fixture: App and its static main are indexed nodes of App.swift', () => {
    expect(byName(ix, 'App', APP_FILE)).toHaveLength(1);
    expect(byName(ix, 'main', APP_FILE)).toHaveLength(1);
  });

  it('R1-5: App is excluded as an entry point, so the & continuation line does not hide its @main', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${APP_FILE}:App`);
  });

  it('R1-5: static main of App is excluded as an entry point', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${APP_FILE}:main`);
  });

  it('R1-5: both are counted as entry exclusions', () => {
    expect(reportOf(outcome).excluded.entry).toBe(2);
  });
});

// --- R1-6 (O-07): a member of an extension of a nested type joins that type's conformances -----

const JOINED_FILE = 'Sources/Q/Joined.swift';
const OTHER_FILE = 'Sources/Q/Other.swift';
const QUAL_C1: Record<string, string> = {
  'Sources/Q/API.swift': 'enum API {\n    struct Outer {}\n}\n',
  'Sources/Q/Ext.swift': 'extension API.Outer {\n    struct Inner: Encodable {}\n}\n',
};
const QUAL_C2: Record<string, string> = {
  // encode in an extension of the nested type: it joins API.Outer.Inner, whose Encodable the struct declares.
  [JOINED_FILE]: 'extension API.Outer.Inner {\n    func encode(to e: Encoder) throws {}\n}\n',
  // The control: an unrelated Other.Inner with no conformance; its encode must not join API.Outer.Inner.
  [OTHER_FILE]: 'enum Other {\n    struct Inner {}\n}\n\nextension Other.Inner {\n    func encode(to e: Encoder) throws {}\n}\n',
};

describe('review round 1 R1-6 (O-07): a member of an extension of a nested type joins that type\'s conformances', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-qualified-', QUAL_C1, (r) => writeAll(r, QUAL_C2));
    ix = indexRows(root);
    writeNodeProbe(root, ['Sources/Q/API.swift', 'Sources/Q/Ext.swift', JOINED_FILE, OTHER_FILE], 'cg-orphans-review-r1-qualified-probe.txt');
    outcome = await orphansOf(root);
  }, 120_000);

  it('R1-6 fixture: encode is indexed in both extension files, and struct Inner in Ext.swift holds a failed Encodable reference', () => {
    expect(byName(ix, 'encode', JOINED_FILE)).toHaveLength(1);
    expect(byName(ix, 'encode', OTHER_FILE)).toHaveLength(1);
    const inner = byName(ix, 'Inner', 'Sources/Q/Ext.swift');
    expect(inner).toHaveLength(1);
    expect(ix.unresolved.some((u) => u.from_node_id === inner[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
  });

  it('R1-6: encode in extension API.Outer.Inner is excluded as an implementation (joined to the Encodable of struct Inner)', () => {
    expect(keysOf(reportOf(outcome))).not.toContain(`${JOINED_FILE}:encode`);
  });

  it('R1-6 control: encode in extension Other.Inner is listed, since API.Outer.Inner does not join the unrelated Other.Inner', () => {
    expect(keysOf(reportOf(outcome))).toContain(`${OTHER_FILE}:encode`);
  });
});

// --- R1-7 (O-05): the Rust attribute walk over a long run of comment lines --------------------

const LONG_COMMENTS = 3000;
const LONG_FILE = 'src/long.rs';
const WALK_C1: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "walk"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub fn seed() -> u32 {\n    1\n}\n',
};
const WALK_C2: Record<string, string> = {
  // A run of consecutive comment lines, then an added fn with no attribute and a #[test] fn after it.
  [LONG_FILE]: `${Array.from({ length: LONG_COMMENTS }, (_, i) => `// comment line ${i + 1}`).join('\n')}\n` +
    'pub fn tail_plain() -> u32 {\n    1\n}\n\n#[test]\nfn tail_test() {}\n',
};

describe('review round 1 R1-7 (O-05): the Rust attribute walk over a long run of comment lines', () => {
  let root = '';
  let ix: IndexRows;
  let outcome: Outcome;
  let siblingReads = -1;

  beforeAll(async () => {
    root = await fixtureRepo('cg-orphans-review-r1-rust-walk-', WALK_C1, (r) => writeAll(r, WALK_C2));
    ix = indexRows(root);
    // The deterministic count: reads of previousNamedSibling, the attribute walk's only step, on
    // web-tree-sitter's Node while findOrphans runs. A plain counter on the prototype getter (no call recording).
    const desc = Object.getOwnPropertyDescriptor(TsNode.prototype, 'previousNamedSibling');
    if (!desc?.get) throw new Error('web-tree-sitter Node has no previousNamedSibling getter');
    let reads = 0;
    Object.defineProperty(TsNode.prototype, 'previousNamedSibling', {
      ...desc,
      get(this: TsNode) {
        reads += 1;
        return desc.get!.call(this);
      },
    });
    try {
      outcome = await orphansOf(root);
    } finally {
      Object.defineProperty(TsNode.prototype, 'previousNamedSibling', desc);
      siblingReads = reads;
    }
  }, 180_000);

  it('R1-7 fixture: tail_plain and tail_test are indexed in src/long.rs, after the comment run', () => {
    expect(byName(ix, 'tail_plain', LONG_FILE)).toHaveLength(1);
    expect(byName(ix, 'tail_test', LONG_FILE)).toHaveLength(1);
    expect(byName(ix, 'tail_plain', LONG_FILE)[0]!.start_line).toBe(LONG_COMMENTS + 1);
  });

  it('R1-7 correctness: both are added, tail_plain is listed, tail_test is excluded as a test', () => {
    const r = reportOf(outcome);
    expect(r.added).toBe(2);
    expect(keysOf(r)).toContain(`${LONG_FILE}:tail_plain`);
    expect(keysOf(r)).not.toContain(`${LONG_FILE}:tail_test`);
    expect(r.excluded.test).toBe(1);
  });

  // slow: the cost under test. Before the round-1 rework the walk read the comment run once per comment node,
  // so the beforeAll took seconds; the walk is now linear, and the count, not the time, is what this asserts.
  it('R1-7: the attribute walk reads previousNamedSibling at most 10 times per node (linear, not quadratic in the comment run)', () => {
    expect(siblingReads).toBeLessThanOrEqual(10 * (LONG_COMMENTS + 20));
  });
});

// =====================================================================================
// Review round 2: the reviewer's Swift local-type findings. Before the local-type fix
// (at 5aa60266) the Swift parse gave a type declared in a function body, a closure or a
// computed getter the path of its nearest enclosing type, so at file level its type path
// was its bare name and every same-named top-level type joined it; a type nested in a
// local type took the local type's name as a prefix, so two such nests joined each other.
// Since 7fdd6640 such a type, and anything nested in it, has no path and joins nothing.
// Each case is its own fixture repo: the cases share the names Widget, W and Gizmo, and one
// repo would join them. R2-1 to R2-4 were fail-first (red at 5aa60266 at the listed
// assertion) and pass after the fix. R2-5 and the member pin under R2-3 are pins.
// =====================================================================================

describe('review round 2: Swift local types', () => {
  describe('R2-1 (O-07) red: a Widget local to second() is not the Encodable Widget local to first()', () => {
    const FIRST = 'Sources/Loc/First.swift';
    const SECOND = 'Sources/Loc/Second.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-review-r2-local-',
        { [FIRST]: 'func first() { struct Widget: Encodable {} }\n' },
        (r) => write(r, SECOND, 'func second() { struct Widget { func encode() {} } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('R2-1 fixture: first() holds a Widget with a failed Encodable reference; second() holds a Widget that holds encode', () => {
      const first = byName(ix, 'Widget', FIRST);
      expect(first).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === first[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const second = byName(ix, 'Widget', SECOND);
      const enc = byName(ix, 'encode', SECOND);
      expect(second).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === second[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('R2-1 probe: writes the names and qualified names the index gives the function-local Widget and its encode (asserts nothing)', () => {
      writeNodeProbe(root, [FIRST, SECOND], 'cg-orphans-review-r2-local-probe.txt');
    });

    it('R2-1: encode in second()\'s Widget is listed, not excluded as the Encodable implementation of first()\'s Widget', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${SECOND}:encode`);
    });
  });

  describe('R2-2 red: a Widget local to a closure is not the top-level Encodable Widget', () => {
    const TOP = 'Sources/Loc/Top.swift';
    const CLOSURE = 'Sources/Loc/Closure.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      // The closure sits in a function. A top-level property's children are skipped by the Swift variable branch
      // (tree-sitter.ts, the variable dispatch with skipChildren), so a top-level closure would index no Widget.
      root = await fixtureRepo(
        'cg-orphans-review-r2-closure-',
        { [TOP]: 'struct Widget: Encodable {}\n' },
        (r) => write(r, CLOSURE, 'func makeClosure() { let f = { struct Widget { func encode() {} } } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('R2-2 fixture: the top-level Widget holds a failed Encodable reference; the closure\'s Widget holds encode', () => {
      const top = byName(ix, 'Widget', TOP);
      expect(top).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === top[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const local = byName(ix, 'Widget', CLOSURE);
      const enc = byName(ix, 'encode', CLOSURE);
      expect(local).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === local[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('R2-2: encode in the closure-local Widget is listed, not excluded as the Encodable implementation of the top-level Widget', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${CLOSURE}:encode`);
    });
  });

  describe('R2-3 red: a Widget local to a computed getter is not the top-level Encodable Widget; a getter\'s type in a struct keeps its own path', () => {
    const TOP = 'Sources/Loc/Top.swift';
    const LOCAL = 'Sources/Loc/Local.swift';
    const MEMBER = 'Sources/Loc/Holder.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      // The local getter sits in a function, as the closure does: a top-level computed property is skipped by the
      // same Swift variable branch, so its Widget would not be indexed. The member getter, in a struct, is the pin.
      root = await fixtureRepo(
        'cg-orphans-review-r2-getter-',
        { [TOP]: 'struct Widget: Encodable {}\n' },
        (r) => writeAll(r, {
          [LOCAL]: 'func readX() { var x: Int { struct Widget { func encode() {} }; return 1 } }\n',
          [MEMBER]: 'struct Holder {\n    var x: Int { struct Widget { func encode() {} }; return 1 }\n}\n',
        }),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('R2-3 fixture: the top-level Widget holds a failed Encodable reference; each getter\'s Widget holds encode, and Holder is a struct', () => {
      const top = byName(ix, 'Widget', TOP);
      expect(top).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === top[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      for (const file of [LOCAL, MEMBER]) {
        const widget = byName(ix, 'Widget', file);
        const enc = byName(ix, 'encode', file);
        expect(widget).toHaveLength(1);
        expect(enc).toHaveLength(1);
        expect(ix.edges.some((e) => e.kind === 'contains' && e.source === widget[0]!.id && e.target === enc[0]!.id)).toBe(true);
      }
      expect(byName(ix, 'Holder', MEMBER).map((n) => n.kind)).toEqual(['struct']);
    });

    it('R2-3: encode in the Widget local to readX\'s getter is listed, not excluded as the top-level Widget\'s Encodable implementation', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${LOCAL}:encode`);
    });

    it('R2-3 pin: encode in the Widget local to Holder\'s getter is listed, since a type declared in a getter body is local and joins nothing', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${MEMBER}:encode`);
    });
  });

  describe('R2-4 red: a type nested in a function-local type is not the nested type of another function-local type that conforms', () => {
    const CONFORMING = 'Sources/Loc/G.swift';
    const NESTED = 'Sources/Loc/F.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-review-r2-nested-',
        { [CONFORMING]: 'func g() { struct W { struct In: Encodable {} } }\n' },
        (r) => write(r, NESTED, 'func f() { struct W { struct In { func encode() {} } } }\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('R2-4 fixture: the In of g() holds a failed Encodable reference; the In of f() holds encode', () => {
      const conforming = byName(ix, 'In', CONFORMING);
      expect(conforming).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === conforming[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      const nested = byName(ix, 'In', NESTED);
      const enc = byName(ix, 'encode', NESTED);
      expect(nested).toHaveLength(1);
      expect(enc).toHaveLength(1);
      expect(ix.edges.some((e) => e.kind === 'contains' && e.source === nested[0]!.id && e.target === enc[0]!.id)).toBe(true);
    });

    it('R2-4: encode in the In of f() is listed, not excluded as the Encodable implementation of the In of g()', () => {
      expect(keysOf(reportOf(outcome))).toContain(`${NESTED}:encode`);
    });
  });

  describe('R2-5 pin: an extension\'s encode is excluded when its struct is declared under #if and #else', () => {
    const GIZMO = 'Sources/Loc/Gizmo.swift';
    const CODABLE = 'Sources/Loc/GizmoCodable.swift';
    let root = '';
    let ix: IndexRows;
    let outcome: Outcome;

    beforeAll(async () => {
      root = await fixtureRepo(
        'cg-orphans-review-r2-ifdef-',
        { [GIZMO]: '#if DEBUG\nstruct Gizmo {}\n#else\nstruct Gizmo {}\n#endif\n' },
        (r) => write(r, CODABLE, 'extension Gizmo: Encodable {\n    func encode(to e: Encoder) throws {}\n}\n'),
      );
      ix = indexRows(root);
      outcome = await orphansOf(root);
    }, 120_000);

    it('R2-5 fixture: both #if branches index a struct Gizmo; the extension holds a failed Encodable reference and encode', () => {
      const structs = byName(ix, 'Gizmo', GIZMO);
      expect(structs).toHaveLength(2);
      expect(structs.every((n) => n.kind === 'struct')).toBe(true);
      const ext = byName(ix, 'Gizmo', CODABLE);
      expect(ext).toHaveLength(1);
      expect(ix.unresolved.some((u) => u.from_node_id === ext[0]!.id && u.reference_name === 'Encodable' && u.status === 'failed')).toBe(true);
      expect(byName(ix, 'encode', CODABLE)).toHaveLength(1);
    });

    it('R2-5 pin: encode in the extension of Gizmo is excluded as an implementation, through the #if structs', () => {
      expect(keysOf(reportOf(outcome))).not.toContain(`${CODABLE}:encode`);
    });
  });
});
