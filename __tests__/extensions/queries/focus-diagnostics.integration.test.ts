/**
 * Focus diagnostics: `CodeGraph.getExploreMissDiagnostics(query, pathPrefixes)`, the lexical evidence explore prints for
 * an empty result. It reports which words of the query the index matches, which it does not, and which indexed names
 * sit near them. With a non-empty list, the matched words, the unmatched words and the candidates come only from
 * nodes whose file is in focus, decided by `inPathPrefixes`: index-relative, equal to a prefix or below it on
 * whole segments, case-sensitively. A file or import node can make a word matched; no such node is ever a candidate.
 * An absent or empty list is no focus, and the answer is the unfocused one.
 *
 * `getUnseenNames` takes no focus. Its "not in the index" statement is about the whole index, so it is answered
 * index-wide, and the describe 'getUnseenNames is index-wide and takes no focus' pins that.
 *
 * Two repositories hold the same files. One is indexed as a current release indexes it. The other has
 * `name_segment_vocab` dropped, the state a pre-v7 index has for that table. Its schema version still reads current, so
 * only this table is missing. It is opened read-only, which runs no migrations.
 *
 * The last describe builds its own repository, to pin that the focus sits inside each candidate statement before its
 * LIMIT, and on the same node row as the kind test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../../../src';

/** What `getExploreMissDiagnostics` returns. */
interface MissDiagnostics {
  matched: string[];
  unmatched: string[];
  candidates: string[];
  limited: boolean;
}

/**
 * Declared locally: vitest does not type-check and tsconfig excludes __tests__, so these calls are not checked against
 * CodeGraph's own signatures.
 */
interface DiagnosticsApi {
  getExploreMissDiagnostics(query: string, pathPrefixes?: readonly string[]): MissDiagnostics;
  getUnseenNames(names: readonly string[]): string[];
}

const api = (cg: CodeGraph): DiagnosticsApi => cg as unknown as DiagnosticsApi;

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where each word of the queries is held:
 *  - renderPane (src/app): "render" is its name prefix. "pane" is only one of its name segments, so only the segment
 *    vocab finds it; no name starts with "pane".
 *  - billingLedgerSync and cacheVaultKey (src/lib): "b" and "c" are their name prefixes. "frobnicate" is a word of
 *    billingLedgerSync's docstring, so it is a docstring-only match.
 *  - bannerCascade (src/application, a sibling whose path shares the letters of src/app): "banner" is its name prefix,
 *    and "quuxify" is a word of its docstring that no other symbol holds.
 * No symbol in src/app has a docstring, so no docstring word of src/app can match. bannerCascade's docstring also holds
 * 'the'. That is harmless here: src/application is outside the src/app focus, and no symbol in src/app has a docstring.
 */
const FILES: Record<string, string> = {
  'src/app/app.ts': 'export function renderPane(): string { return "pane"; }\n',
  'src/lib/secret.ts':
    '/** Reconciles the frobnicate backlog. */\n' +
    'export function billingLedgerSync(): void {}\n' +
    'export function cacheVaultKey(): string { return "key"; }\n',
  'src/application/banner.ts': '/** Quuxify the widgets. */\nexport function bannerCascade(): void {}\n',
};

interface Repo {
  root: string;
  cg: CodeGraph;
}

function writeRepo(files: Record<string, string> = FILES): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-focus-diagnostics-')));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

/** An index built the way a current release builds it: name_segment_vocab is populated. */
async function indexedRepo(files: Record<string, string> = FILES): Promise<Repo> {
  const root = writeRepo(files);
  const cg = await CodeGraph.init(root, { index: true });
  return { root, cg };
}

/**
 * A current index with `name_segment_vocab` dropped. The drop goes through a writable connection after the index is
 * built; the index is then opened read-only, which runs no migrations (src/db/index.ts), so the table stays gone.
 */
async function preV7Repo(): Promise<Repo> {
  const root = writeRepo();
  const built = await CodeGraph.init(root, { index: true });
  built.close();
  const writer = DatabaseConnection.open(getDatabasePath(root));
  writer.getDb().exec('DROP TABLE name_segment_vocab');
  writer.close();
  return { root, cg: CodeGraph.openSync(root, { readOnly: true }) };
}

function hasVocabTable(cg: CodeGraph): boolean {
  const db = (cg as unknown as { db: DatabaseConnection }).db.getDb();
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'name_segment_vocab'").get() !== undefined;
}

function closeRepo(repo: Repo | undefined): void {
  repo?.cg.close();
  if (repo) fs.rmSync(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

let indexed: Repo;
let preV7: Repo;

beforeAll(async () => {
  indexed = await indexedRepo();
  preV7 = await preV7Repo();
});

afterAll(() => {
  closeRepo(indexed);
  closeRepo(preV7);
});

// ---------------------------------------------------------------------------------------------------------------
// Without a focus: the answers are pinned
// ---------------------------------------------------------------------------------------------------------------

describe('without a focus the answers are the unfocused ones (indexed repository)', () => {
  it('pins the answers for a call with no list', () => {
    const cg = indexed.cg;
    // Candidates come out in row order of the name search, which follows indexing order (src/application/banner.ts
    // before src/lib/secret.ts). The vocab branch is listed first in the UNION ALL, but nothing here exercises it.
    expect(api(cg).getExploreMissDiagnostics('b c')).toEqual({
      matched: ['b', 'c'],
      unmatched: [],
      candidates: ['bannerCascade', 'billingLedgerSync', 'cacheVaultKey'],
      limited: false,
    });
    expect(api(cg).getExploreMissDiagnostics('the')).toEqual({
      matched: ['the'],
      unmatched: [],
      candidates: [],
      limited: false,
    });
    expect(api(cg).getExploreMissDiagnostics('frobnicate render')).toEqual({
      matched: ['frobnicate', 'render'],
      unmatched: [],
      candidates: ['renderPane'],
      limited: false,
    });
    expect(api(cg).getExploreMissDiagnostics('pane')).toEqual({
      matched: ['pane'],
      unmatched: [],
      candidates: ['renderPane'],
      limited: false,
    });
    expect(api(cg).getExploreMissDiagnostics('banner quuxify')).toEqual({
      matched: ['banner', 'quuxify'],
      unmatched: [],
      candidates: ['bannerCascade'],
      limited: false,
    });
  });

  it('an absent, undefined or empty list gives the same answer as no list, for every query', () => {
    const cg = indexed.cg;
    for (const query of ['b c', 'the', 'frobnicate render', 'pane', 'banner quuxify']) {
      const bare = api(cg).getExploreMissDiagnostics(query);
      expect(api(cg).getExploreMissDiagnostics(query, [])).toEqual(bare);
      expect(api(cg).getExploreMissDiagnostics(query, undefined)).toEqual(bare);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Under a focus: matched, unmatched and candidates come from in-focus nodes only
// ---------------------------------------------------------------------------------------------------------------

describe('under a focus the diagnostics read in-focus nodes only (indexed repository)', () => {
  it('a word held only out of focus is unmatched, and no out-of-focus name is a candidate', () => {
    // billingLedgerSync and bannerCascade (for "b") and cacheVaultKey (for "c") are all out of src/app.
    // renderPane holds neither letter as a prefix, so nothing in focus matches.
    expect(api(indexed.cg).getExploreMissDiagnostics('b c', ['src/app'])).toEqual({
      matched: [],
      unmatched: ['b', 'c'],
      candidates: [],
      limited: false,
    });
  });

  it('a word that only out-of-focus docstrings hold is unmatched', () => {
    // "the" appears in the docstrings of src/lib/secret.ts and src/application/banner.ts, both out of src/app.
    const diagnostics = api(indexed.cg).getExploreMissDiagnostics('the', ['src/app']);
    expect(diagnostics.matched).not.toContain('the');
    expect(diagnostics).toEqual({
      matched: [],
      unmatched: ['the'],
      candidates: [],
      limited: false,
    });
  });

  it('an in-focus name prefix matches and its name is a candidate, while an out-of-focus docstring word stays unmatched', () => {
    expect(api(indexed.cg).getExploreMissDiagnostics('render frobnicate', ['src/app'])).toEqual({
      matched: ['render'],
      unmatched: ['frobnicate'],
      candidates: ['renderPane'],
      limited: false,
    });
  });

  it('a word the in-focus file holds only as a name segment still matches', () => {
    // "pane" is no name prefix in src/app, so only the segment vocab finds renderPane.
    expect(api(indexed.cg).getExploreMissDiagnostics('pane', ['src/app'])).toEqual({
      matched: ['pane'],
      unmatched: [],
      candidates: ['renderPane'],
      limited: false,
    });
  });

  it('a list is the union of its prefixes', () => {
    // src/lib and src/app together: billingLedgerSync and cacheVaultKey are in focus, bannerCascade is not.
    expect(api(indexed.cg).getExploreMissDiagnostics('b c', ['src/lib', 'src/app'])).toEqual({
      matched: ['b', 'c'],
      unmatched: [],
      candidates: ['billingLedgerSync', 'cacheVaultKey'],
      limited: false,
    });
  });

  it('a docstring word of an in-focus definition matches', () => {
    // "frobnicate" is in billingLedgerSync's docstring, in src/lib. "render" is renderPane's, which src/lib does not hold.
    expect(api(indexed.cg).getExploreMissDiagnostics('frobnicate render', ['src/lib'])).toEqual({
      matched: ['frobnicate'],
      unmatched: ['render'],
      candidates: [],
      limited: false,
    });
  });

  it('the prefix is case-sensitive: src/App matches nothing in src/app', () => {
    expect(api(indexed.cg).getExploreMissDiagnostics('render', ['src/App'])).toEqual({
      matched: [],
      unmatched: ['render'],
      candidates: [],
      limited: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The sibling directory: src/application shares its letters with src/app but is not inside it
// ---------------------------------------------------------------------------------------------------------------

describe('the sibling src/application under a focus on src/app (indexed repository)', () => {
  it('its name word and its docstring-only word are unmatched, and bannerCascade is not a candidate', () => {
    // "banner" is bannerCascade's name prefix and "quuxify" is only in its docstring.
    const diagnostics = api(indexed.cg).getExploreMissDiagnostics('banner quuxify', ['src/app']);
    expect(diagnostics.candidates).not.toContain('bannerCascade');
    expect(diagnostics).toEqual({
      matched: [],
      unmatched: ['banner', 'quuxify'],
      candidates: [],
      limited: false,
    });
  });

  it('a partial segment matches nothing: src/applic is not a directory that holds src/application', () => {
    expect(api(indexed.cg).getExploreMissDiagnostics('render banner', ['src/applic'])).toEqual({
      matched: [],
      unmatched: ['render', 'banner'],
      candidates: [],
      limited: false,
    });
  });

  it('under its own focus the sibling answers, so the focus is not vacuous', () => {
    expect(api(indexed.cg).getExploreMissDiagnostics('banner quuxify', ['src/application'])).toEqual({
      matched: ['banner', 'quuxify'],
      unmatched: [],
      candidates: ['bannerCascade'],
      limited: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// An index without name_segment_vocab (the table migration v7 adds)
// ---------------------------------------------------------------------------------------------------------------

describe('an index without name_segment_vocab (the table migration v7 adds)', () => {
  it('has no vocab table, and the indexed repository has one', () => {
    expect(hasVocabTable(preV7.cg)).toBe(false);
    expect(hasVocabTable(indexed.cg)).toBe(true);
  });

  it('the in-focus answers match the indexed repository: "b c" is unmatched under src/app, "render" matches renderPane', () => {
    const cg = preV7.cg;
    expect(api(cg).getExploreMissDiagnostics('b c', ['src/app'])).toEqual({
      matched: [],
      unmatched: ['b', 'c'],
      candidates: [],
      limited: false,
    });
    expect(api(cg).getExploreMissDiagnostics('render', ['src/app'])).toEqual({
      matched: ['render'],
      unmatched: [],
      candidates: ['renderPane'],
      limited: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// getUnseenNames: index-wide by design, no focus parameter
// ---------------------------------------------------------------------------------------------------------------

describe('getUnseenNames is index-wide and takes no focus (indexed repository)', () => {
  it('reports the names the whole index has never seen, and only those', () => {
    expect(api(indexed.cg).getUnseenNames(['billingLedgerSync', 'renderPane', 'nothingHereAtAll'])).toEqual(['nothingHereAtAll']);
  });

  it('an out-of-focus name is still seen when a focus list is passed, because the check does not narrow', () => {
    // billingLedgerSync is out of src/app and is still seen: "not in the index" is a statement about the whole index.
    const withFocus = (indexed.cg as unknown as {
      getUnseenNames(names: readonly string[], pathPrefixes: readonly string[]): string[];
    }).getUnseenNames(['billingLedgerSync', 'renderPane', 'nothingHereAtAll'], ['src/app']);
    expect(withFocus).toEqual(['nothingHereAtAll']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The focus sits inside each candidate statement, before its LIMIT, and on the same node row as the kind filter
// ---------------------------------------------------------------------------------------------------------------

/** The names of the ledger functions in src/api: each is `ledger<Name>Pane`, and each sorts before `ledgerPane`. */
const LEDGER_NAMES = [
  'Account', 'Balance', 'Cash', 'Debit', 'Entry', 'Fee', 'Group',
  'Header', 'Invoice', 'Journal', 'Key', 'Line', 'Memo',
];

/**
 * Which rows come first, and why. The name search returns rows in rowid order, and a row's rowid is its insertion
 * order, so the rows that must fill the LIMIT are indexed before the in-focus rows.
 *  - CROWD_FILES is the first index pass. src/api holds 13 `ledger*Pane` functions, so their rows get the lowest rowids.
 *    Without the focus, the FTS LIMIT 12 would fill with them. The segment vocab is keyed (segment, name) and comes back
 *    in name order, where the same 13 sort before ledgerPane.
 *  - FOCUS_FILES is written after that pass and added by sync, so its rows take the higher rowids whatever the directory
 *    listing order. src/app/screens.ts defines ledgerPane. "ledger" is its name prefix and a segment, so both candidate
 *    subqueries can return it; "pane" is only a segment (the vocab returns it), and "led" only a name prefix (the FTS
 *    search returns it).
 *  - src/app/x.ts imports the module zebraWidget. The TypeScript extractor names an import node by its module
 *    specifier, so this is an in-focus import node named zebraWidget. Its only definition, in src/lib/zebra.ts, is out
 *    of focus.
 */
const CROWD_FILES: Record<string, string> = {
  'src/api/ledger.ts': LEDGER_NAMES.map((name) => `export function ledger${name}Pane(): void {}\n`).join(''),
};
const FOCUS_FILES: Record<string, string> = {
  'src/app/screens.ts': 'export function ledgerPane(): void {}\n',
  'src/app/x.ts': "import zebraWidget from 'zebraWidget';\n",
  'src/lib/zebra.ts': 'export function zebraWidget(): string { return "zebra"; }\n',
};

/**
 * An index whose first pass holds `first`. The files in `later` are written after it and added by `sync`, so their rows
 * take the higher rowids.
 */
async function indexedRepoInOrder(first: Record<string, string>, later: Record<string, string>): Promise<Repo> {
  const root = writeRepo(first);
  const cg = await CodeGraph.init(root, { index: true });
  for (const [rel, body] of Object.entries(later)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  await cg.sync();
  return { root, cg };
}

describe('the focus before each LIMIT and on the same row (its own indexed repository)', () => {
  let focused: Repo;

  beforeAll(async () => {
    focused = await indexedRepoInOrder(CROWD_FILES, FOCUS_FILES);
  });

  afterAll(() => {
    closeRepo(focused);
  });

  it('out-of-focus rows do not use up the LIMIT of the FTS or the vocab candidate search', () => {
    const cg = focused.cg;
    const db = (cg as unknown as { db: DatabaseConnection }).db.getDb();

    // Fixture check, read with no focus: the first 12 name-search rows are all src/api's, and the first 12 vocab rows
    // for 'ledger' and for 'pane' leave ledgerPane out. If either fails, the assertions below cannot tell a focus that
    // sits before the LIMIT from one that sits after it.
    const ftsFirst = db
      .prepare(
        "SELECT n.file_path AS filePath FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid " +
          "WHERE nodes_fts MATCH ? AND n.kind NOT IN ('file', 'import') ORDER BY nodes_fts.rowid LIMIT 12",
      )
      .all('name : ("ledger"*)') as Array<{ filePath: string }>;
    expect(ftsFirst.map((r) => r.filePath)).toEqual(Array.from({ length: 12 }, () => 'src/api/ledger.ts'));
    const vocabFirst = (segment: string): string[] =>
      (db
        .prepare('SELECT name FROM name_segment_vocab WHERE segment = ? ORDER BY name LIMIT 12')
        .all(segment) as Array<{ name: string }>).map((r) => r.name);
    expect(vocabFirst('ledger')).not.toContain('ledgerPane');
    expect(vocabFirst('pane')).not.toContain('ledgerPane');

    // 'ledger' is a name prefix (FTS) and a segment (vocab) of all 14 names.
    expect(api(cg).getExploreMissDiagnostics('ledger', ['src/app'])).toEqual({
      matched: ['ledger'],
      unmatched: [],
      candidates: ['ledgerPane'],
      limited: false,
    });
    // 'pane' is a segment of ledgerPane and no name starts with it, so only the vocab subquery can return it.
    expect(api(cg).getExploreMissDiagnostics('pane', ['src/app'])).toEqual({
      matched: ['pane'],
      unmatched: [],
      candidates: ['ledgerPane'],
      limited: false,
    });
    // 'led' is a name prefix of ledgerPane and not a segment of any name, so only the FTS subquery can return it.
    expect(api(cg).getExploreMissDiagnostics('led', ['src/app'])).toEqual({
      matched: ['led'],
      unmatched: [],
      candidates: ['ledgerPane'],
      limited: false,
    });
  });

  it('an import in focus does not stand in for an out-of-focus definition of the same name', () => {
    const cg = focused.cg;
    const db = (cg as unknown as { db: DatabaseConnection }).db.getDb();

    // Fixture check: the import in focus and the definition out of focus share the name zebraWidget.
    expect(
      db.prepare("SELECT kind, file_path AS filePath FROM nodes WHERE name = 'zebraWidget' ORDER BY file_path").all(),
    ).toEqual([
      { kind: 'import', filePath: 'src/app/x.ts' },
      { kind: 'function', filePath: 'src/lib/zebra.ts' },
    ]);
    // 'widget' is a segment of zebraWidget only. Under src/app the import is in focus and the definition is not, so the
    // word is unmatched and zebraWidget is no candidate.
    expect(api(cg).getExploreMissDiagnostics('widget', ['src/app'])).toEqual({
      matched: [],
      unmatched: ['widget'],
      candidates: [],
      limited: false,
    });
    // Control: under src/lib the definition is in focus, so the same word matches and zebraWidget is a candidate.
    expect(api(cg).getExploreMissDiagnostics('widget', ['src/lib'])).toEqual({
      matched: ['widget'],
      unmatched: [],
      candidates: ['zebraWidget'],
      limited: false,
    });
  });
});
