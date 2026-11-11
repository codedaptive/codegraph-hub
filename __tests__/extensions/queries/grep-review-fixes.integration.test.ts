/**
 * grep-by-symbol review fixes: a file changed since it was indexed (R2-05) and
 * the 0-based UTF-16 column of each hit, used to pick the innermost symbol on a
 * line (R2-06). Several cases keep the names they have in commit e0b18e67
 * (`__tests__/grep-by-symbol.test.ts` there); the raw-stage cases are new. Each
 * case is either red (it fails at an assertion on the pre-fix code) or a control
 * (it guards behaviour the pre-fix code already has); the comments say which.
 *
 * Fixtures are temp projects indexed for real: no DB mocking. Suites with one
 * fixture index in beforeAll. A stale-file case edits its own file, so it indexes
 * its own project in the test body.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { grepIndex, searchIndexText, CappedHits, type RawHit } from '../../../src/extensions/queries/grep/grep-core';
import { formatGrepResult } from '../../../src/extensions/queries/grep/grep-format';

/** Remove the temp projects a suite made. */
function removeProjects(dirs: string[]): void {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write `files` into a new temp project and index it. `forceWasm` sets
 * CODEGRAPH_KERNEL=0 for the indexing only, which sends every language to the
 * wasm extractors; otherwise each language uses the extractor it is routed to.
 */
async function indexTempProject(files: Record<string, string>, made: string[], forceWasm = false): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-review-fixes-'));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const saved = process.env.CODEGRAPH_KERNEL;
  if (forceWasm) process.env.CODEGRAPH_KERNEL = '0';
  try {
    const cg = await CodeGraph.init(dir, { index: true });
    cg.close();
  } finally {
    if (forceWasm) {
      if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = saved;
    }
  }
  return dir;
}

/** Group headers in output order, as `name|kind|path|span|inDegree` (or `module|path|inDegree`). */
const groupKeys = (r: Awaited<ReturnType<typeof grepIndex>>): string[] =>
  r.groups.map((g) =>
    g.symbol
      ? `${g.symbol.name}|${g.symbol.kind}|${g.symbol.path}|${g.symbol.span}|${g.inDegree}`
      : `module|${g.path}|${g.inDegree}`,
  );

const byPathThenLine = (a: RawHit, b: RawHit): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line;

/** A search's hits reduced to {path, line, text}, sorted by path then line. */
const textHits = (hits: RawHit[]): RawHit[] =>
  hits.map(({ path: p, line, text }) => ({ path: p, line, text })).sort(byPathThenLine);

/** A grepIndex result's group hits, flattened to {path, line, text} and sorted by path then line. */
const flattenedGroupHits = (r: Awaited<ReturnType<typeof grepIndex>>): RawHit[] =>
  textHits(r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text }))));

/** The column a raw hit carries. RawHit has no column before the fix, so it is read through a cast. */
const columnOf = (h: RawHit): unknown => (h as RawHit & { column?: unknown }).column;

interface IndexedNode {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

/** The index's node rows for one file, ordered by name. */
const indexedNodes = (dir: string, file: string): IndexedNode[] => {
  const conn = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
  try {
    return conn
      .getDb()
      .prepare(
        'SELECT name, kind, start_line, end_line, start_column, end_column FROM nodes WHERE file_path = ? ORDER BY name',
      )
      .all(file) as IndexedNode[];
  } finally {
    conn.close();
  }
};

/** Shared by the changed-file suite and the raw-stage suite. */
const ONE_HIT = 'function alpha() {\n  return "HIT";\n}\nfunction beta() {\n  return 1;\n}\n';
const TWO_HITS = 'function alpha() {\n  return "HIT";\n}\nfunction beta() {\n  return "HIT";\n}\n';
/** The same text with three blank lines in front, so every line number moves down by three. */
const shifted = (text: string): string => '\n\n\n' + text;

/**
 * The index keeps each file's size, mtime and content hash from its last sync,
 * and each symbol's line span. A file edited since then is still searched with
 * its current bytes, so its hits have current line numbers, but the spans are
 * the old ones. Hits in a changed file are not attributed to a symbol.
 */
describe('grepIndex: file changed since indexing', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  /**
   * Set a file's mtime a minute ahead, so the size-and-mtime check cannot clear
   * it and the content hash decides.
   */
  const bumpMtime = (file: string): void => {
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
  };

  // Red: the pre-fix code attributes the shifted hit to beta and sets no stale flag.
  it('a file edited after its last sync is not attributed to the symbols its old lines named', async () => {
    // Indexes its own project in the test body, because the test edits the file it indexed.
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    fs.writeFileSync(path.join(dir, 'a.ts'), shifted(ONE_HIT));
    const r = await grepIndex(dir, 'HIT');
    expect(r.totalHits).toBe(1);
    expect(r.groups).toEqual([
      { symbol: null, path: 'a.ts', inDegree: 0, hits: [{ line: 5, text: 'return "HIT";' }], stale: true },
    ]);
    expect(Object.keys(r.groups[0] as object)).toEqual(['symbol', 'path', 'inDegree', 'hits', 'stale']);
  });

  // Control: the bytes match the index, so the hash check clears the file; the pre-fix code also attributes it.
  it('a file rewritten with identical bytes and a new mtime keeps its symbol attribution', async () => {
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    const file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, ONE_HIT);
    // A new mtime sends the check to the content hash, which matches the index here.
    bumpMtime(file);
    const r = await grepIndex(dir, 'HIT');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].symbol?.name).toBe('alpha');
    expect(r.groups[0].hits).toEqual([{ line: 2, text: 'return "HIT";' }]);
    expect('stale' in r.groups[0]).toBe(false);
  });

  // Red: the pre-fix header names beta's span, not the changed-file header.
  it('the text output gives a changed file its own header and lists its hits under it', async () => {
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    fs.writeFileSync(path.join(dir, 'a.ts'), shifted(ONE_HIT));
    expect(formatGrepResult(await grepIndex(dir, 'HIT'))).toBe(
      [
        '"HIT" — 1 hits in 1 symbols across 1 files (searched 1 indexed files)',
        '',
        'a.ts (changed since indexed, not attributed; run codegraph sync)',
        '  L5: return "HIT";',
        '',
      ].join('\n'),
    );
  });

  // Red: the pre-fix code splits the hits across beta and the module-level group, with no stale flag.
  it('a changed file with several hits is one group, and every hit is listed', async () => {
    const dir = await indexTempProject({ 'a.ts': TWO_HITS }, made);
    fs.writeFileSync(path.join(dir, 'a.ts'), shifted(TWO_HITS));
    const r = await grepIndex(dir, 'HIT');
    expect(r.totalHits).toBe(2);
    expect(r.groups).toEqual([
      {
        symbol: null,
        path: 'a.ts',
        inDegree: 0,
        hits: [
          { line: 5, text: 'return "HIT";' },
          { line: 8, text: 'return "HIT";' },
        ],
        stale: true,
      },
    ]);
  });

  // Red: the changed a.ts group is wrong on the pre-fix code, so the whole groups array fails.
  it('a file that did not change in the same search keeps its symbol attribution', async () => {
    const dir = await indexTempProject(
      { 'a.ts': ONE_HIT, 'c.ts': 'export function gamma(): string {\n  return "HIT";\n}\n' },
      made,
    );
    fs.writeFileSync(path.join(dir, 'a.ts'), shifted(ONE_HIT));
    const r = await grepIndex(dir, 'HIT');
    expect(r.groups).toEqual([
      { symbol: null, path: 'a.ts', inDegree: 0, hits: [{ line: 5, text: 'return "HIT";' }], stale: true },
      {
        symbol: { id: 'c.ts#gamma', name: 'gamma', kind: 'function', path: 'c.ts', span: 'L1-L3' },
        path: 'c.ts',
        inDegree: 0,
        hits: [{ line: 2, text: 'return "HIT";' }],
      },
    ]);
  });

  // Control: the pre-fix search already opens one read-only connection and closes it once.
  it('a search with a changed file closes its one database connection', async () => {
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    fs.writeFileSync(path.join(dir, 'a.ts'), shifted(ONE_HIT));
    const close = vi.spyOn(DatabaseConnection.prototype, 'close');
    try {
      await grepIndex(dir, 'HIT');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  // Red: same size, new mtime, changed bytes. Pre-fix nothing is checked, so the
  // hit keeps alpha. The size matches, so a size check alone would clear the file;
  // the new mtime sends the check to the content hash.
  it('a file with the same size and a new mtime whose bytes changed is stale: the content hash decides', async () => {
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    const file = path.join(dir, 'a.ts');
    // One letter swapped on the beta line: the size stays the same and no line moves.
    const edited = ONE_HIT.replace('function beta', 'function bota');
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(ONE_HIT));
    fs.writeFileSync(file, edited);
    bumpMtime(file);
    const r = await grepIndex(dir, 'HIT');
    expect(r.groups).toEqual([
      { symbol: null, path: 'a.ts', inDegree: 0, hits: [{ line: 2, text: 'return "HIT";' }], stale: true },
    ]);
  });
});

/** Single-quote a path for a POSIX shell script. */
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The ripgrep the search would run: CODEGRAPH_RG when set, else the `rg` the shell finds on PATH. */
const realRg = (): string =>
  process.env.CODEGRAPH_RG ?? execFileSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim();

/**
 * The freshness check reads a hit's file when its size or mtime differs from its
 * `files` row. If the path was a regular file when rg searched it and is a FIFO
 * by the time of the check, a blocking open and read waits until a writer opens
 * the FIFO, and a blocked call stops every timer in the process. The check now
 * opens with O_NONBLOCK and treats a file that is not regular as changed
 * (matchesRow); this case holds it to that. POSIX only: it needs mkfifo and a
 * shell.
 */
describe('grepIndex: a searched file replaced by a FIFO before the freshness check', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  // Red: pre-fix, the check's open blocks until the watchdog releases it after 6 s, so the elapsed assertion
  // fails. The groups are right; only the wait is wrong. The test takes about 6 s before the fix, which is over
  // the 5 s default. The 20 s timeout covers that wait plus the indexing. The watchdog, not the timeout, releases
  // a blocked open, so the test cannot hang.
  it.runIf(process.platform !== 'win32')(
    'the search does not block on a FIFO: it returns in under 3 s with the file flagged stale',
    async () => {
      // Indexes its own project in the test body, because the test replaces the file it indexed.
      const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
      const file = path.join(dir, 'a.ts');
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-rg-wrapper-'));
      made.push(workDir);
      const out = path.join(workDir, 'rg-output.json');
      // Runs the real rg to completion (it has read a.ts by then), swaps a.ts for a FIFO, then prints rg's
      // output and exits with rg's code.
      const wrapper = path.join(workDir, 'rg-then-fifo');
      fs.writeFileSync(
        wrapper,
        [
          '#!/bin/sh',
          `RG=${shellQuote(realRg())}`,
          `OUT=${shellQuote(out)}`,
          `TARGET=${shellQuote(file)}`,
          '"$RG" "$@" > "$OUT"',
          'code=$?',
          'rm -f "$TARGET"',
          'mkfifo "$TARGET"',
          'cat "$OUT"',
          'exit $code',
          '',
        ].join('\n'),
      );
      fs.chmodSync(wrapper, 0o755);

      // Opens the FIFO for writing after 6 s and closes it at once, so a read blocked on it sees end of file. Its
      // own process group, so the test can kill it and its sleep whatever happens.
      const watchdog = spawn('/bin/sh', ['-c', 'sleep 6; exec 3>"$1"; exec 3>&-', 'sh', file], {
        detached: true,
        stdio: 'ignore',
      });
      try {
        const started = Date.now();
        const r = await grepIndex(dir, 'HIT', { rgPath: wrapper });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(3000);
        expect(r.groups).toEqual([
          { symbol: null, path: 'a.ts', inDegree: 0, hits: [{ line: 2, text: 'return "HIT";' }], stale: true },
        ]);
      } finally {
        try {
          if (watchdog.pid) process.kill(-watchdog.pid, 'SIGKILL');
        } catch {
          /* the watchdog has already exited */
        }
      }
    },
    20_000,
  );
});

/**
 * rg reports a match's column as a byte offset in its line. The index stores
 * each symbol's start and end column in UTF-16 code units, as the extractor set
 * them (LINE_ONLY_LANGUAGES in grep-core.ts lists the files whose columns do not
 * match a hit's). A hit is attributed to a symbol whose columns also hold the
 * match when one spans its line, and otherwise to the innermost symbol on the line.
 */
const LINE_1 = "function a() { return 'A'; } function b() { return 'B'; }";
const COLUMN_FILE = [
  LINE_1, // L1: two one-line functions
  'function outer() {', // L2
  "  return 'D'; function inner() { return 'C'; }", // L3: a hit, then a nested function on one line
  '}', // L4
  'function c() {', // L5
  "  return 'é'; }function d() { return 'D2'; }", // L6: a two-byte character, then c's brace touching d
  '',
].join('\n');

describe.each(['default', 'wasm'] as const)('grepIndex: match columns, %s extractor', (backend) => {
  const made: string[] = [];
  let project = '';
  beforeAll(async () => {
    project = await indexTempProject({ 'a.ts': COLUMN_FILE }, made, backend === 'wasm');
  });
  afterAll(() => removeProjects(made));

  // Red: the pre-fix line-only lookup picks b (both functions start and end on line 1; b has the lower id).
  it("'A' is attributed to the function that holds it, not to the later one on its line", async () => {
    const r = await grepIndex(project, "'A'", { fixed: true });
    expect(groupKeys(r)).toEqual(['a|function|a.ts|L1-L1|0']);
    expect(r.groups[0].hits).toEqual([{ line: 1, text: LINE_1 }]);
  });

  // Control: the pre-fix line-only lookup already picks b for 'B', the answer the column rule gives too.
  it("'B' is attributed to the second function on its line", async () => {
    expect(groupKeys(await grepIndex(project, "'B'", { fixed: true }))).toEqual(['b|function|a.ts|L1-L1|0']);
  });

  // Red: the pre-fix line-only lookup picks b; the first match ('A', in a) should decide.
  it('a line where two functions each hold a match is one hit, attributed by its first match', async () => {
    const r = await grepIndex(project, "'A'|'B'");
    expect(r.totalHits).toBe(1);
    expect(groupKeys(r)).toEqual(['a|function|a.ts|L1-L1|0']);
  });

  // Red: the pre-fix line-only lookup picks inner (it starts on line 3); the hit sits before it, in outer.
  it('a hit before a nested function starts belongs to the function around it', async () => {
    expect(groupKeys(await grepIndex(project, "'D'", { fixed: true }))).toEqual(['outer|function|a.ts|L2-L4|0']);
  });

  // Control: the hit sits inside inner, and the pre-fix line-only lookup already picks inner (greatest start line).
  it('a hit inside a nested function belongs to that function', async () => {
    expect(groupKeys(await grepIndex(project, "'C'", { fixed: true }))).toEqual(['outer.inner|function|a.ts|L3-L3|0']);
  });

  // Red: the pre-fix line-only lookup picks d (it starts on line 6); the brace closes c.
  it('columns count UTF-16 code units, so a brace after a two-byte character still closes its function', async () => {
    expect(groupKeys(await grepIndex(project, '}function d', { fixed: true }))).toEqual(['c|function|a.ts|L5-L6|0']);
  });
});

/**
 * A free-format COBOL program. The COBOL extractor shifts every line of a
 * free-format file right by seven columns (cobol.ts preParse), so a node's
 * columns and a hit's column do not count from the same origin. The procedure
 * division makes no node; each paragraph is a function node from its header to
 * the next header (the last one to the end of the program), and the program is
 * a module node.
 */
const FREE_FORMAT_COBOL = [
  'IDENTIFICATION DIVISION.',
  'PROGRAM-ID. HELLO.',
  'PROCEDURE DIVISION.',
  'HIT-PARA.', // L4: the paragraph header holds the hit
  '    DISPLAY "HELLO".',
  '    STOP RUN.',
  '',
].join('\n');

describe('grepIndex: match columns in a free-format COBOL program', () => {
  const made: string[] = [];
  let project = '';
  beforeAll(async () => {
    project = await indexTempProject({ 'hello.cbl': FREE_FORMAT_COBOL }, made);
  });
  afterAll(() => removeProjects(made));

  // Control: line-only ordering already picks the paragraph. It starts on line 4, later than the module (line 1),
  // so the greatest start line wins. A column rule would see a shifted start column and must fall back to lines.
  it('a hit on a paragraph header line goes to that paragraph, by line alone', async () => {
    // Precondition: the module and the paragraph are the only non-file nodes; the procedure division has no row.
    const nodes = indexedNodes(project, 'hello.cbl').filter((n) => n.kind !== 'file');
    expect(
      nodes.map((n) => `${n.name}|${n.kind}|L${n.start_line}-L${n.end_line}|C${n.start_column}-C${n.end_column}`),
    ).toEqual(['HELLO|module|L1-L6|C7-C20', 'HIT-PARA|function|L4-L6|C7-C16']);

    const r = await grepIndex(project, 'HIT', { fixed: true });
    expect(groupKeys(r)).toEqual(['HELLO.HIT-PARA|function|hello.cbl|L4-L6|0']);
    expect(r.groups[0].hits).toEqual([{ line: 4, text: 'HIT-PARA.' }]);
  });
});

/**
 * A Vue file's script block is parsed as its own source, so the columns on the
 * block's first line count from the end of the opening tag, while a hit's
 * column counts from the start of the file's line. The two do not compare, so
 * a hit in such a file is attributed by line alone.
 */
describe('grepIndex: match columns in an embedded script block', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  /** `inner` sits on the block's first line, after `outer` has opened; `outer` closes on line 2. */
  const NESTED_VUE = "<script setup>function outer() { function inner() { return 'C'; } return 'D';\n}</script>";

  // Control: the pre-fix line-only lookup already picks inner. It indexes in the test
  // body, so the index counts against the 30 s test timeout (vitest.config.mts), not
  // the longer 60 s hook timeout.
  it('a hit inside a nested function on the first script line is attributed to that function', async () => {
    const dir = await indexTempProject({ 'Nested.vue': NESTED_VUE }, made);
    // Precondition: outer spans lines 1-2 and inner sits on line 1.
    const nodes = indexedNodes(dir, 'Nested.vue');
    expect(nodes.filter((n) => n.kind === 'function').map((n) => `${n.name}:${n.start_line}-${n.end_line}`)).toEqual([
      'inner:1-1',
      'outer:1-2',
    ]);

    // Line-only ordering picks the greatest start line (1 for all three), then the smallest end
    // line: inner ends on line 1, so it is the innermost span.
    expect(groupKeys(await grepIndex(dir, "'C'", { fixed: true }))).toEqual(['outer.inner|function|Nested.vue|L1-L1|0']);
  });
});

/**
 * A Dart method is a signature node whose body is its next sibling. The method
 * spans from the signature to the body's last row, but keeps the signature's end
 * column (createNode in src/extraction/tree-sitter.ts). A hit past that column on
 * the span's last line fails the column containment, so the class around it wins.
 * Each hit should be attributed by line alone, as LINE_ONLY_LANGUAGES does for its
 * other files, so that it reaches the method.
 */
/** L1-L5. The add signature is on L2 (end column 16) and its body runs to L3. The arrow method is L4 (end column 11). */
const DART_SOURCE = [
  'class Calc {',
  '  int add(int x) {',
  '    return x + 1; } // DARTHIT',
  "  int get v => 'DARTARROW';",
  '}',
  '',
].join('\n');

describe.each(['default', 'wasm'] as const)('grepIndex: method columns in Dart, %s extractor', (backend) => {
  const made: string[] = [];
  let project = '';
  beforeAll(async () => {
    project = await indexTempProject({ 'calc.dart': DART_SOURCE }, made, backend === 'wasm');
  });
  afterAll(() => removeProjects(made));

  // Red: pre-fix, add's span ends at column 16 on L3 and the hit is at column 23, so Calc wins.
  it("a hit on a method's last body line, past the signature's end column, goes to that method", async () => {
    // Precondition: add's rows end on the hit's line, and its end column is before the hit's column.
    const add = indexedNodes(project, 'calc.dart').find((n) => n.name === 'add');
    expect(add).toMatchObject({ kind: 'method', start_line: 2, end_line: 3, end_column: 16 });
    expect(DART_SOURCE.split('\n')[2]!.indexOf('DARTHIT')).toBeGreaterThan(add!.end_column);

    const r = await grepIndex(project, 'DARTHIT', { fixed: true });
    expect(groupKeys(r)).toEqual(['Calc.add|method|calc.dart|L2-L3|0']);
    expect(r.groups[0].hits).toEqual([{ line: 3, text: 'return x + 1; } // DARTHIT' }]);
  });

  // Red: pre-fix, v's span ends at column 11 on L4 and the hit is at column 16, so Calc wins.
  it("a hit in a one-line arrow method's body, past the signature's end column, goes to that method", async () => {
    // Precondition: v's rows sit on one line, and its end column is before the hit's column.
    const v = indexedNodes(project, 'calc.dart').find((n) => n.name === 'v');
    expect(v).toMatchObject({ kind: 'method', start_line: 4, end_line: 4, end_column: 11 });
    expect(DART_SOURCE.split('\n')[3]!.indexOf('DARTARROW')).toBeGreaterThan(v!.end_column);

    const r = await grepIndex(project, 'DARTARROW', { fixed: true });
    expect(groupKeys(r)).toEqual(['Calc.v|method|calc.dart|L4-L4|0']);
    expect(r.groups[0].hits).toEqual([{ line: 4, text: "int get v => 'DARTARROW';" }]);
  });
});

/**
 * A liquid schema block is one constant node from `{% schema %}` to
 * `{% endschema %}`, written with an end column of 0 (src/extraction/liquid-extractor.ts).
 * On its end line ENCLOSING_SQL reads that 0 as an unknown end, not a bound, so the
 * schema still contains a hit there and a tag that starts later on that line does
 * not take it. The enclosing-node form of this does not occur in liquid: the file
 * node is the only other liquid node that spans lines, and it never encloses a hit.
 */
describe('grepIndex: match columns on the end line of a liquid schema', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  // Red: pre-fix, the schema fails containment on L2 (end column 0), and the render tag that starts later on L2 wins.
  it('a hit inside a schema on its last line goes to the schema, not to a tag after it on that line', async () => {
    const LIQUID_SOURCE = '{% schema %}\n{"name": "Banner", "description": "HIT"}{% endschema %}{% render \'footer\' %}\n';
    const dir = await indexTempProject({ 'sections/banner.liquid': LIQUID_SOURCE }, made);
    // Precondition: the schema ends on the hit's line with end column 0, and the render tag starts after the hit.
    const nodes = indexedNodes(dir, 'sections/banner.liquid');
    const schema = nodes.find((n) => n.kind === 'constant');
    const footer = nodes.find((n) => n.kind === 'component');
    expect(schema).toMatchObject({ name: 'Banner', start_line: 1, end_line: 2, end_column: 0 });
    expect(footer!.start_line).toBe(2);
    expect(footer!.start_column).toBeGreaterThan(LIQUID_SOURCE.split('\n')[1]!.indexOf('HIT'));

    const r = await grepIndex(dir, 'HIT', { fixed: true });
    expect(groupKeys(r)).toEqual(['sections/banner.liquid.schema:Banner|constant|sections/banner.liquid|L1-L2|0']);
  });
});

/**
 * A MyBatis statement is one method node from its opening tag to its closing tag,
 * with both its start and end column set to 0 (src/extraction/mybatis-extractor.ts).
 * The rows hold no real column for a statement, so nothing in them says where a
 * statement's text starts or ends on a line that two statements share. Statements
 * do not nest, and the file node is not an enclosing candidate, so on such a line
 * the candidates are those statements. The unknown-end rule in ENCLOSING_SQL (end
 * column 0 on a node that spans lines) is meant for liquid's schema. Before xml
 * went line-only it also applied to a statement, which is why findAll took a hit
 * on its last line. Now xml goes by line alone (LINE_ONLY_LANGUAGES), so every hit
 * on a shared line goes to the statement that starts later on it.
 */
describe('grepIndex: MyBatis statements sharing a line, attributed by line alone', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  const MAPPER_SOURCE = [
    '<?xml version="1.0" encoding="UTF-8"?>', // L1
    '<mapper namespace="com.example.UserMapper">', // L2
    '  <select id="findAll" resultType="User">', // L3
    `    SELECT id FROM users WHERE name = 'HIT'</select><select id="countAll" resultType="int">SELECT COUNT(*) FROM users</select>`, // L4
    '</mapper>', // L5
    '',
  ].join('\n');

  // Red: pre-fix, findAll takes this hit. Its end column 0 reads as an unknown end on L4,
  // which ranks findAll above countAll, the statement that starts later on the same line.
  it('a hit in the second of two statements on one line goes to that second statement', async () => {
    const dir = await indexTempProject({ 'UserMapper.xml': MAPPER_SOURCE }, made);
    // Precondition: both statements carry column 0 at each end, so the rows cannot place a hit by column.
    const nodes = indexedNodes(dir, 'UserMapper.xml');
    const findAll = nodes.find((n) => n.name === 'findAll');
    const countAll = nodes.find((n) => n.name === 'countAll');
    expect(findAll).toMatchObject({ kind: 'method', start_line: 3, end_line: 4, start_column: 0, end_column: 0 });
    expect(countAll).toMatchObject({ kind: 'method', start_line: 4, end_line: 4, start_column: 0, end_column: 0 });
    // Precondition: the COUNT(*) text is inside countAll, after its opening tag on L4.
    const line4 = MAPPER_SOURCE.split('\n')[3]!;
    expect(line4.indexOf('COUNT(*)')).toBeGreaterThan(line4.indexOf('<select id="countAll"'));

    const r = await grepIndex(dir, 'COUNT(*)', { fixed: true });
    expect(groupKeys(r)).toEqual(['com.example.UserMapper.countAll|method|UserMapper.xml|L4-L4|0']);
  });

  // Red: pre-fix, findAll takes this hit too, for the reason above. The hit is in findAll's text,
  // before countAll starts, so findAll is the statement it is in. The rows hold no real column for a
  // mybatis statement, so attribution by line alone gives countAll. That is a known limit, not a
  // correct answer; the assertion records the limit and does not endorse it.
  it("a hit in the first statement's tail on a shared line goes to the later statement, by line alone (known limit)", async () => {
    const dir = await indexTempProject({ 'UserMapper.xml': MAPPER_SOURCE }, made);
    // Precondition: both statements carry column 0 at each end, as in the test above.
    const nodes = indexedNodes(dir, 'UserMapper.xml');
    const findAll = nodes.find((n) => n.name === 'findAll');
    const countAll = nodes.find((n) => n.name === 'countAll');
    expect(findAll).toMatchObject({ kind: 'method', start_line: 3, end_line: 4, start_column: 0, end_column: 0 });
    expect(countAll).toMatchObject({ kind: 'method', start_line: 4, end_line: 4, start_column: 0, end_column: 0 });
    // Precondition: the HIT text is before countAll's opening tag on L4, so it is in findAll's tail.
    const line4 = MAPPER_SOURCE.split('\n')[3]!;
    expect(line4.indexOf('HIT')).toBeLessThan(line4.indexOf('<select id="countAll"'));

    const r = await grepIndex(dir, 'HIT', { fixed: true });
    expect(groupKeys(r)).toEqual(['com.example.UserMapper.countAll|method|UserMapper.xml|L4-L4|0']);
  });
});

/** CappedHits carries a hit's column through kept(). */
describe('CappedHits: column carried through', () => {
  // Red: the pre-fix kept() maps each hit to path, line and text only, so the column is dropped.
  it('kept() returns a hit with the column it was added with', () => {
    const c = new CappedHits(new Map([['a.ts', 0]]), 5);
    c.add({ path: 'a.ts', line: 3, text: 'x', column: 7 } as RawHit);
    expect(c.kept()).toEqual([{ path: 'a.ts', line: 3, text: 'x', column: 7 }]);
  });

  // Control: a hit added without a column comes back without one, on the pre-fix code too.
  it('kept() omits the column key for a hit added without one', () => {
    const c = new CappedHits(new Map([['a.ts', 0]]), 5);
    c.add({ path: 'a.ts', line: 3, text: 'x' });
    const kept = c.kept()[0] as RawHit;
    expect(kept).toEqual({ path: 'a.ts', line: 3, text: 'x' });
    expect('column' in kept).toBe(false);
  });
});

/**
 * The raw stage (searchIndexText) against grepIndex on one fresh index: the same
 * file list, truncation, pattern and hits. Grouping is the only thing grepIndex
 * adds, so these cases are controls on the pre-fix code.
 */
const PARITY_FILES: Record<string, string> = {
  'src/a.ts': 'export function one(): string {\n  return "HIT";\n}\nexport function two(): string {\n  return "HIT";\n}\n',
  'src/b.ts': 'export function three(): string {\n  return "HIT";\n}\n',
  'src/c.ts': 'export const plain = 1;\n',
};

describe('searchIndexText: parity with grepIndex (raw stage)', () => {
  const made: string[] = [];
  let project = '';
  beforeAll(async () => {
    project = await indexTempProject(PARITY_FILES, made);
  });
  afterAll(() => removeProjects(made));

  // Control: the raw stage returns the same files searched, truncation, pattern and hits as grepIndex.
  it('returns the same files searched, truncation, pattern and hits as grepIndex', async () => {
    const grouped = await grepIndex(project, 'HIT');
    expect(grouped.totalHits).toBe(3);
    const raw = await searchIndexText(project, 'HIT');
    expect(raw.filesSearched).toBe(grouped.filesSearched);
    expect(raw.truncated).toEqual(grouped.truncated);
    expect(raw.pattern).toBe(grouped.pattern);
    expect(textHits(raw.hits)).toEqual(flattenedGroupHits(grouped));
  });

  // Control: with a cap below the hit count, both stages keep the same first hits and count the rest as truncated.
  it('with maxHits below the hit count, keeps the same hits and counts the rest as truncated', async () => {
    const grouped = await grepIndex(project, 'HIT', { maxHits: 2 });
    const raw = await searchIndexText(project, 'HIT', { maxHits: 2 });
    expect(grouped.totalHits).toBe(2);
    expect(raw.truncated).toEqual(grouped.truncated);
    expect(raw.truncated.hits).toBe(1);
    expect(textHits(raw.hits)).toEqual(flattenedGroupHits(grouped));
  });

  // Control: a stale file is still searched with its current bytes; the raw
  // stage has no stale flag, before or after this change.
  it('a changed file comes back raw from searchIndexText: current line numbers, no stale flag', async () => {
    // Indexes its own project in the test body, because the test edits the file it indexed.
    const made2: string[] = [];
    try {
      const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made2);
      fs.writeFileSync(path.join(dir, 'a.ts'), shifted(ONE_HIT));
      const raw = await searchIndexText(dir, 'HIT');
      expect(textHits(raw.hits)).toEqual([{ path: 'a.ts', line: 5, text: 'return "HIT";' }]);
      expect(raw.hits.some((h) => 'stale' in h)).toBe(false);
    } finally {
      removeProjects(made2);
    }
  });
});

/** Hit columns on the raw stage: the 0-based UTF-16 column of the first submatch. */
describe('searchIndexText: hit columns', () => {
  const made: string[] = [];
  afterEach(() => removeProjects(made));

  // Red: the pre-fix raw hits carry no column at all.
  it('a hit carries the 0-based column of its first submatch', async () => {
    const dir = await indexTempProject({ 'a.ts': ONE_HIT }, made);
    const raw = await searchIndexText(dir, 'HIT');
    // `  return "HIT";`: the match starts at column 10.
    expect(raw.hits.map((h) => columnOf(h))).toEqual([10]);
  });

  // Red: the pre-fix raw hits carry no column, so the UTF-16 count cannot be seen. A byte offset would give 15.
  it('a column counts UTF-16 code units, so a two-byte character before the match counts once', async () => {
    const dir = await indexTempProject({ 'a.ts': COLUMN_FILE }, made);
    const raw = await searchIndexText(dir, '}function d', { fixed: true });
    expect(raw.hits.map((h) => h.line)).toEqual([6]);
    // `  return 'é'; }function d`: the brace is at UTF-16 column 14; its UTF-8 byte offset is 15.
    expect(raw.hits.map((h) => columnOf(h))).toEqual([14]);
  });
});
