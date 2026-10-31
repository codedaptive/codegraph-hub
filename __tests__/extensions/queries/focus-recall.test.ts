/**
 * Focus recall: the path focus, `pathPrefixes`, applied BEFORE every top-N limit of the context recall and of the
 * lookups beneath it, so an in-focus symbol is not crowded out by out-of-focus hits that fill the limit first.
 *
 * A prefix is index-relative and matches by the host rule (`inFocus`, src/extensions/host/server/session-scope.ts):
 * the path equals the prefix or lies below it, on whole segments, case-sensitively. The host rule holds for a
 * non-empty list. An absent or empty list is no filter, and the answer is the unfocused one: that is the one
 * difference from `inFocus`, which reads an empty list as "nothing is in focus".
 *
 * Five repositories, each indexed once in beforeAll. Every out-of-focus family is sized above the limit it must
 * cross, so a lookup without a filter fills its limit with out-of-focus rows:
 *  - widget: src/app/panel.ts (renderWidgetPanel), src/application/other.ts (renderWidgetOther, a sibling whose
 *    name shares the letters "src/app"), and 60 src/lib files holding buildWidgetNN / widgetHelperNN. The
 *    acceptance, sibling, pin, kind-only and substring checks read it.
 *  - recall: gizmo (the FTS cap), panel (the LIKE fallback), renderpnl (the fuzzy cap), sprocket (the exact-name
 *    supplement, and the exact-name fetch).
 *  - segments: 21 names hold the segment "widget" (tier B of getSegmentMatches takes the two rarest of the
 *    segments held by 2..25 names) and 28 hold both "render" and "panel".
 *  - tierb: three prompt words, none in a name with another. "alpha" and "bravo" are each in two out-of-focus
 *    names (the two rarest segments by whole-index count); "charlie" is in three names, one in src/app.
 *  - paths: one function, pathVector, in each of src/a_b, src/aXb, src/a%b, src/Q_b and src/𝒜pp (an astral
 *    character), the directories a LIKE or a UTF-16 length in the prefix SQL would confuse.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { inPathPrefixes } from '../../../src/db/queries';
import { inFocus } from '../../../src/extensions/host/server/session-scope';
import type { FindRelevantContextOptions, SearchOptions, Subgraph } from '../../../src/types';

const FOCUS = ['src/app'];

/** The QueryBuilder methods the contract extends. CodeGraph keeps its QueryBuilder in a private field. */
interface Lookups {
  findNodesByExactName(names: string[], options?: SearchOptions): Array<{ node: { name: string; filePath: string }; score: number }>;
  findNodesByNameSubstring(
    substring: string,
    options?: SearchOptions & { excludePrefix?: boolean },
  ): Array<{ node: { name: string; filePath: string }; score: number }>;
  getSegmentCoOccurrence(
    variants: Array<{ segment: string; word: string }>,
    minWords: number,
    limit: number,
    pathPrefixes?: readonly string[],
  ): Array<{ name: string; matches: number }>;
  getNamesForSegment(segment: string, limit: number, pathPrefixes?: readonly string[]): string[];
  getSegmentNameCounts(segments: string[]): Map<string, number>;
}

interface Repo {
  root: string;
  cg: CodeGraph;
  lookups: Lookups;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * Letter-only suffixes for generated names. A digit stays glued to the word before it (`widget00` is one segment),
 * so numeric suffixes would not split into the segments these tests count.
 */
const WORDS = [
  'Ant', 'Bee', 'Cat', 'Dog', 'Elk', 'Fox', 'Gnu', 'Hen', 'Ibis', 'Jay', 'Kiwi', 'Lynx', 'Mole', 'Newt',
  'Owl', 'Pig', 'Quail', 'Rat', 'Seal', 'Toad', 'Urn', 'Vole', 'Wasp', 'Yak', 'Zebu', 'Ape', 'Eel',
];

/**
 * The 60 buildWidgetNN names are 13 characters, shorter than renderWidgetPanel (17). The substring lookup orders by
 * length and the kind-only lookup by name, and both put every buildWidgetNN ahead of the in-focus name, which is
 * what the limits in the substring and kind-only tests meet.
 */
function widgetFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'src/app/panel.ts': 'export function renderWidgetPanel(): string { return "in-focus-panel"; }\n',
    'src/application/other.ts': 'export function renderWidgetOther(): string { return "sibling"; }\n',
  };
  for (let i = 0; i < 60; i++) {
    const n = pad(i);
    files[`src/lib/widget${n}.ts`] =
      `export function buildWidget${n}(): string { return "widget"; }\n` +
      `export function widgetHelper${n}(): string { return buildWidget${n}(); }\n`;
  }
  return files;
}

/**
 * Segment families. The "widget" segment is in 21 names (20 out of focus, 1 in); "render" and "panel" are both in
 * 28 names. Every out-of-focus name is shorter than renderWidgetPanel, the in-focus name, so the length ordering
 * of the segment queries reaches the out-of-focus names first.
 */
function segmentFiles(): Record<string, string> {
  let widgets = '';
  for (const w of WORDS.slice(0, 20)) widgets += `export function buildWidget${w}(): string { return "w"; }\n`;
  let panels = '';
  for (const w of WORDS) panels += `export function renderPanel${w}(): string { return "p"; }\n`;
  return {
    'src/app/view.ts': 'export function renderWidgetPanel(): string { return "in-focus"; }\n',
    'src/lib/widgets.ts': widgets,
    'src/lib/panels.ts': panels,
  };
}

/**
 * One-substitution variants of "renderpnl" (60 of them, more than max(2*limit, 50) for limit 6). Each is within edit
 * distance 1 of the query, contains no "renderpnl" and starts with no "renderpnl", so FTS and LIKE miss them and the
 * fuzzy fallback is the path that finds them. The in-focus renderPanel is at distance 2.
 */
function renderpnlVariants(): string[] {
  const base = 'renderpnl';
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const out: string[] = [];
  for (let pos = 0; pos < base.length && out.length < 60; pos++) {
    for (const c of letters) {
      if (c === base[pos] || out.length >= 60) continue;
      out.push(base.slice(0, pos) + c + base.slice(pos + 1));
    }
  }
  return out;
}

/**
 * The recall repository. Each family uses its own term, so no family's rows reach another family's lookups, except
 * renderPanel, the one row two families reach (gizmo through its signature, panel through its name). In this
 * fixture the src/api rows (out of focus, "sprocket") are indexed before the src/app rows (in focus), so the
 * out-of-focus rows hold the lower row ids; the exact-name fetch reads rows in that order.
 */
function recallFiles(): Record<string, string> {
  const files: Record<string, string> = {
    // gizmo, FTS cap: the in-focus row matches only through its signature, which gives it a lower BM25 score than
    // the 110 out-of-focus name matches. Without a filter, 112 FTS rows match "gizmo"; the in-focus one is the 112th.
    'src/app/views.ts': 'export function renderPanel(view: GizmoView): string { return "in-focus-panel"; }\n',
    // sprocket: the in-focus exact name has a long signature, so its BM25 score is below the short-signature rows.
    'src/app/sprocket.ts': 'export function sprocket(alpha: number, beta: string, gamma: boolean, delta: string): void {}\n',
  };
  // More than 100 in-focus rows (the 101 fillers, and two file rows) rank above the in-focus exact row, so the FTS
  // cap of 100, once filtered, excludes it, and only the exact-name supplement can return it.
  let fillers = '';
  for (let i = 0; i < 101; i++) fillers += `export function sprocket${pad(i, 3)}(config: SprocketConfig): void {}\n`;
  files['src/app/sprockets.ts'] = fillers;
  // 155 out-of-focus rows named exactly "sprocket", one per file: more than the exact-name pass-2 fetch of 150.
  for (let i = 0; i < 155; i++) files[`src/api/s${pad(i, 3)}.ts`] = 'export function sprocket(config: SprocketConfig): void {}\n';
  let gizmos = '';
  for (let i = 0; i < 110; i++) gizmos += `export function gizmo${pad(i, 3)}(): void {}\n`;
  files['src/lib/gizmos.ts'] = gizmos;
  // panel, LIKE fallback: names holding "panel" in the middle (no token starts with it, so FTS finds none), shorter
  // than renderPanel, so the LIKE ordering by length reaches them first. 12 > the limit of 6.
  let aPanel = '';
  for (let i = 0; i < 12; i++) aPanel += `export function aPanel${pad(i)}(): void {}\n`;
  files['src/lib/fill.ts'] = aPanel;
  files['src/lib/fuzzy.ts'] = renderpnlVariants().map((v) => `export function ${v}(): void {}\n`).join('');
  return files;
}

/**
 * Tier B of getSegmentMatches. The words alpha, bravo and charlie are each a segment of names that hold none of the
 * other two, so tier A (co-occurrence) finds nothing and tier B runs. Whole-index counts: alpha 2, bravo 2, charlie 3,
 * so alpha and bravo are the two rarest. Both of theirs are out of focus; charlie's fooCharlie is in src/app.
 */
function tierBFiles(): Record<string, string> {
  return {
    'src/lib/alpha.ts': 'export function fooAlpha(): void {}\nexport function barAlpha(): void {}\n',
    'src/lib/bravo.ts': 'export function fooBravo(): void {}\nexport function barBravo(): void {}\n',
    'src/lib/charlie.ts': 'export function barCharlie(): void {}\nexport function bazCharlie(): void {}\n',
    'src/app/charlie.ts': 'export function fooCharlie(): void {}\n',
  };
}

async function openRepo(files: Record<string, string>): Promise<Repo> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-focus-recall-')));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const cg = await CodeGraph.init(root, { index: true });
  const lookups = (cg as unknown as { queries: Lookups }).queries;
  return { root, cg, lookups };
}

/**
 * The prefix-SQL repository. pathVector is defined once in each directory. A LIKE in the prefix SQL would read the
 * `_` of src/a_b as a wildcard (matching src/aXb), the `%` of src/a%b as one, and fold the case of src/Q_b (the
 * prefix src/q_b); a UTF-16 length in place of the code-point length would cut src/𝒜pp/ one character too long and
 * miss it. No directory differs from another in case alone: a case-insensitive file system would merge them.
 */
const PATH_DIRS = ['src/a_b', 'src/aXb', 'src/a%b', 'src/Q_b', 'src/𝒜pp'];
function pathFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of PATH_DIRS) files[`${dir}/v.ts`] = 'export function pathVector(): number { return 1; }\n';
  return files;
}

function closeRepo(repo: Repo | undefined): void {
  repo?.cg.close();
  if (repo) fs.rmSync(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

let widget: Repo;
let recall: Repo;
let segments: Repo;
let tierB: Repo;
let paths: Repo;

beforeAll(async () => {
  widget = await openRepo(widgetFiles());
  recall = await openRepo(recallFiles());
  segments = await openRepo(segmentFiles());
  tierB = await openRepo(tierBFiles());
  paths = await openRepo(pathFiles());
});

afterAll(() => {
  closeRepo(widget);
  closeRepo(recall);
  closeRepo(segments);
  closeRepo(tierB);
  closeRepo(paths);
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const label = (n: { name: string; filePath: string }): string => `${n.name}@${n.filePath}`;
const inApp = (filePath: string): boolean => filePath.startsWith('src/app/');

/** The root nodes of a subgraph, in root order. Roots are the entry points the recall returns first. */
const rootNodes = (sg: Subgraph): Array<{ name: string; filePath: string }> =>
  sg.roots.map((id) => sg.nodes.get(id)!).filter((n) => n !== undefined);
const nodeNames = (sg: Subgraph): string[] => [...sg.nodes.values()].map((n) => n.name);

/**
 * A stable, id-free rendering of a subgraph: root order, the node labels in the subgraph's own map order and sorted,
 * the edge count, and the sorted edge labels. Edges are compared as a set, not in their order.
 */
function shape(sg: Subgraph): {
  roots: string[];
  nodeOrder: string[];
  nodes: string[];
  edges: number;
  edgeKinds: string[];
} {
  return {
    roots: rootNodes(sg).map(label),
    nodeOrder: [...sg.nodes.values()].map(label),
    nodes: [...sg.nodes.values()].map(label).sort(),
    edges: sg.edges.length,
    edgeKinds: sg.edges.map((e) => `${e.kind}:${sg.nodes.get(e.source)?.name}->${sg.nodes.get(e.target)?.name}`).sort(),
  };
}

const EXPLORE = { searchLimit: 8, traversalDepth: 3, maxNodes: 200, minScore: 0.2 };

// ---------------------------------------------------------------------------------------------------------------
// Acceptance and sibling: the widget repository
// ---------------------------------------------------------------------------------------------------------------

describe('findRelevantContext under pathPrefixes (widget repository)', () => {
  it('returns the in-focus symbol that the unfocused limits crowd out (default options)', async () => {
    const focus: FindRelevantContextOptions = { pathPrefixes: FOCUS };
    const sg = await widget.cg.findRelevantContext('widget', focus);
    expect(rootNodes(sg).map((n) => n.name)).toContain('renderWidgetPanel');
    const outside = rootNodes(sg).filter((n) => !inApp(n.filePath)).map(label);
    expect(outside).toEqual([]);
  });

  it('returns the in-focus symbol with explore-like options and nothing outside src/app', async () => {
    const focus: FindRelevantContextOptions = { ...EXPLORE, pathPrefixes: FOCUS };
    const sg = await widget.cg.findRelevantContext('widget', focus);
    expect(rootNodes(sg).map((n) => n.name)).toContain('renderWidgetPanel');
    const outside = rootNodes(sg).filter((n) => !inApp(n.filePath)).map(label);
    expect(outside).toEqual([]);
  });

  it('a prefix never reaches the sibling src/application that shares its letters, while the unfocused call does', async () => {
    // The sibling is reachable without a focus: the test is not vacuous.
    const unfocused = await widget.cg.findRelevantContext('render widget');
    expect(nodeNames(unfocused)).toContain('renderWidgetOther');
    const focus: FindRelevantContextOptions = { pathPrefixes: FOCUS };
    const focused = await widget.cg.findRelevantContext('render widget', focus);
    expect(nodeNames(focused)).not.toContain('renderWidgetOther');
    expect(nodeNames(focused)).toContain('renderWidgetPanel');
  });

  it('searchNodes under the prefix returns no row from the sibling directory', () => {
    const options: SearchOptions = { limit: 10, pathPrefixes: FOCUS };
    const rows = widget.cg.searchNodes('render widget', options);
    expect(rows.map((r) => r.node.filePath).filter((p) => !inApp(p))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pins: the unfocused answers are the ones the code gives today
// ---------------------------------------------------------------------------------------------------------------

// The unfocused answers on the widget fixture. What is compared: for findRelevantContext, the root order, the node
// labels in the subgraph's map order and sorted, the edge count and the sorted edge labels; for searchNodes and
// findNodesByExactName, the rows in order with scores to 6 decimals. They show the crowding the focus removes
// (renderWidgetPanel is absent from the unfocused answer). An absent, empty or undefined list must keep these exactly.
const PIN_DEFAULTS = {
  // The subgraph's own node order: the roots, then the nodes the traversal added.
  nodeOrder: [
    'buildWidget00@src/lib/widget00.ts',
    'buildWidget01@src/lib/widget01.ts',
    'buildWidget02@src/lib/widget02.ts',
    'widgetHelper00@src/lib/widget00.ts',
    'widgetHelper01@src/lib/widget01.ts',
    'widgetHelper02@src/lib/widget02.ts',
  ],
  roots: ['buildWidget00@src/lib/widget00.ts', 'buildWidget01@src/lib/widget01.ts', 'buildWidget02@src/lib/widget02.ts'],
  nodes: [
    'buildWidget00@src/lib/widget00.ts',
    'buildWidget01@src/lib/widget01.ts',
    'buildWidget02@src/lib/widget02.ts',
    'widgetHelper00@src/lib/widget00.ts',
    'widgetHelper01@src/lib/widget01.ts',
    'widgetHelper02@src/lib/widget02.ts',
  ],
  edges: 3,
  edgeKinds: [
    'calls:widgetHelper00->buildWidget00',
    'calls:widgetHelper01->buildWidget01',
    'calls:widgetHelper02->buildWidget02',
  ],
};

const PIN_EXPLORE = {
  // The subgraph's own node order: the roots, then the nodes the traversal added.
  nodeOrder: [
    'buildWidget00@src/lib/widget00.ts',
    'buildWidget01@src/lib/widget01.ts',
    'buildWidget02@src/lib/widget02.ts',
    'buildWidget03@src/lib/widget03.ts',
    'buildWidget04@src/lib/widget04.ts',
    'buildWidget05@src/lib/widget05.ts',
    'buildWidget06@src/lib/widget06.ts',
    'buildWidget07@src/lib/widget07.ts',
    'widgetHelper00@src/lib/widget00.ts',
    'widgetHelper01@src/lib/widget01.ts',
    'widgetHelper02@src/lib/widget02.ts',
    'widgetHelper03@src/lib/widget03.ts',
    'widgetHelper04@src/lib/widget04.ts',
    'widgetHelper05@src/lib/widget05.ts',
    'widgetHelper06@src/lib/widget06.ts',
    'widgetHelper07@src/lib/widget07.ts',
  ],
  roots: [
    'buildWidget00@src/lib/widget00.ts',
    'buildWidget01@src/lib/widget01.ts',
    'buildWidget02@src/lib/widget02.ts',
    'buildWidget03@src/lib/widget03.ts',
    'buildWidget04@src/lib/widget04.ts',
    'buildWidget05@src/lib/widget05.ts',
    'buildWidget06@src/lib/widget06.ts',
    'buildWidget07@src/lib/widget07.ts',
  ],
  nodes: [
    'buildWidget00@src/lib/widget00.ts',
    'buildWidget01@src/lib/widget01.ts',
    'buildWidget02@src/lib/widget02.ts',
    'buildWidget03@src/lib/widget03.ts',
    'buildWidget04@src/lib/widget04.ts',
    'buildWidget05@src/lib/widget05.ts',
    'buildWidget06@src/lib/widget06.ts',
    'buildWidget07@src/lib/widget07.ts',
    'widgetHelper00@src/lib/widget00.ts',
    'widgetHelper01@src/lib/widget01.ts',
    'widgetHelper02@src/lib/widget02.ts',
    'widgetHelper03@src/lib/widget03.ts',
    'widgetHelper04@src/lib/widget04.ts',
    'widgetHelper05@src/lib/widget05.ts',
    'widgetHelper06@src/lib/widget06.ts',
    'widgetHelper07@src/lib/widget07.ts',
  ],
  edges: 8,
  edgeKinds: [
    'calls:widgetHelper00->buildWidget00',
    'calls:widgetHelper01->buildWidget01',
    'calls:widgetHelper02->buildWidget02',
    'calls:widgetHelper03->buildWidget03',
    'calls:widgetHelper04->buildWidget04',
    'calls:widgetHelper05->buildWidget05',
    'calls:widgetHelper06->buildWidget06',
    'calls:widgetHelper07->buildWidget07',
  ],
};

const PIN_SEARCH_NODES = [
  'widgetHelper00@src/lib/widget00.ts:46.000002',
  'widgetHelper01@src/lib/widget01.ts:46.000002',
  'widgetHelper02@src/lib/widget02.ts:46.000002',
  'widgetHelper03@src/lib/widget03.ts:46.000002',
  'widgetHelper04@src/lib/widget04.ts:46.000002',
  'widgetHelper05@src/lib/widget05.ts:46.000002',
  'widgetHelper06@src/lib/widget06.ts:46.000002',
  'widgetHelper07@src/lib/widget07.ts:46.000002',
  'widgetHelper08@src/lib/widget08.ts:46.000002',
  'widgetHelper09@src/lib/widget09.ts:46.000002',
];

const PIN_EXACT_NAME = [
  'renderWidgetPanel@src/app/panel.ts:21.000000',
  'buildWidget00@src/lib/widget00.ts:21.000000',
];

describe('unfocused answers are unchanged (pins)', () => {
  it('findRelevantContext with default options is the same for absent, empty and undefined lists', async () => {
    expect(shape(await widget.cg.findRelevantContext('widget'))).toEqual(PIN_DEFAULTS);
    const empty: FindRelevantContextOptions = { pathPrefixes: [] };
    expect(shape(await widget.cg.findRelevantContext('widget', empty))).toEqual(PIN_DEFAULTS);
    const undef: FindRelevantContextOptions = { pathPrefixes: undefined };
    expect(shape(await widget.cg.findRelevantContext('widget', undef))).toEqual(PIN_DEFAULTS);
  });

  it('findRelevantContext with explore-like options is the same for absent, empty and undefined lists', async () => {
    expect(shape(await widget.cg.findRelevantContext('widget', { ...EXPLORE }))).toEqual(PIN_EXPLORE);
    const empty: FindRelevantContextOptions = { ...EXPLORE, pathPrefixes: [] };
    expect(shape(await widget.cg.findRelevantContext('widget', empty))).toEqual(PIN_EXPLORE);
    const undef: FindRelevantContextOptions = { ...EXPLORE, pathPrefixes: undefined };
    expect(shape(await widget.cg.findRelevantContext('widget', undef))).toEqual(PIN_EXPLORE);
  });

  it('searchNodes with a limit and no list gives the same rows, scores included', () => {
    const rows = widget.cg.searchNodes('widget', { limit: 10 });
    expect(rows.map((r) => `${label(r.node)}:${r.score.toFixed(6)}`)).toEqual(PIN_SEARCH_NODES);
    const empty: SearchOptions = { limit: 10, pathPrefixes: [] };
    const emptyRows = widget.cg.searchNodes('widget', empty);
    expect(emptyRows.map((r) => `${label(r.node)}:${r.score.toFixed(6)}`)).toEqual(PIN_SEARCH_NODES);
  });

  it('findNodesByExactName with no list gives the same rows, scores included', () => {
    const rows = widget.lookups.findNodesByExactName(['renderWidgetPanel', 'buildWidget00']);
    expect(rows.map((r) => `${label(r.node)}:${r.score.toFixed(6)}`)).toEqual(PIN_EXACT_NAME);
    const empty: SearchOptions = { pathPrefixes: [] };
    const emptyRows = widget.lookups.findNodesByExactName(['renderWidgetPanel', 'buildWidget00'], empty);
    expect(emptyRows.map((r) => `${label(r.node)}:${r.score.toFixed(6)}`)).toEqual(PIN_EXACT_NAME);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// searchNodes: each candidate source's own limit counts only in-focus rows
// ---------------------------------------------------------------------------------------------------------------

describe('searchNodes under pathPrefixes (recall repository)', () => {
  it('FTS: more than 100 out-of-focus FTS rows for the term, and the in-focus row is still returned', () => {
    // searchNodesFTS fetches max(5*limit, 100) = 100 rows for limit 6; without a filter the in-focus row is the 112th.
    const options: SearchOptions = { limit: 6, pathPrefixes: FOCUS };
    const rows = recall.cg.searchNodes('gizmo', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderPanel']);
  });

  it('LIKE fallback: FTS finds nothing under the term, and the in-focus substring row is still returned', () => {
    // "panel" is no token prefix (FTS: no row), but renderPanel and aPanelNN hold it. 12 out-of-focus rows sort first.
    const options: SearchOptions = { limit: 6, pathPrefixes: FOCUS };
    const rows = recall.cg.searchNodes('panel', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderPanel']);
  });

  it('all-filters path: a kind-only query with more than 5x limit out-of-focus rows ahead still returns the in-focus function', () => {
    // searchAllByFilters takes limit*5 = 30 rows by name. The 60 buildWidgetNN functions sort ahead of renderWidgetPanel.
    const options: SearchOptions = { limit: 6, pathPrefixes: FOCUS };
    const rows = widget.cg.searchNodes('kind:function', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderWidgetPanel']);
  });

  it('fuzzy fallback: 50+ out-of-focus names are nearer the query, and the in-focus name is still returned', () => {
    // FUZZY_FOLLOWUP_CAP = max(2*limit, 50) = 50. The 60 one-substitution variants are at distance 1; renderPanel is at 2.
    const options: SearchOptions = { limit: 6, pathPrefixes: FOCUS };
    const rows = recall.cg.searchNodes('renderpnl', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderPanel']);
  });

  it('exact-name supplement: more than 20 out-of-focus rows named exactly the term, and the in-focus exact row is returned', () => {
    // FTS is non-empty for "sprocket", so the supplement runs. The in-focus exact row ranks 104th of the in-focus FTS
    // rows, beyond the 100 that the filtered FTS keeps, so only the supplement can return it. Without the focus,
    // out-of-focus rows fill the supplement's LIMIT 20.
    const options: SearchOptions = { limit: 6, pathPrefixes: FOCUS };
    const rows = recall.cg.searchNodes('sprocket', options);
    expect(rows.some((r) => r.node.name === 'sprocket' && r.node.filePath === 'src/app/sprocket.ts')).toBe(true);
    const outside = rows.filter((r) => !inApp(r.node.filePath)).map((r) => label(r.node));
    expect(outside).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Lookups beneath searchNodes: the exact-name fetch and the substring lookup
// ---------------------------------------------------------------------------------------------------------------

describe('findNodesByExactName and findNodesByNameSubstring under pathPrefixes', () => {
  it('findNodesByExactName: more than 150 out-of-focus rows named the same, and the in-focus row is still returned', () => {
    // Pass 2 fetches max(perNameLimit*3, 50) = 150 rows for the default limit of 50. The 155 out-of-focus rows fill it.
    const options: SearchOptions = { pathPrefixes: FOCUS };
    const rows = recall.lookups.findNodesByExactName(['sprocket'], options);
    expect(rows.map((r) => label(r.node))).toEqual(['sprocket@src/app/sprocket.ts']);
  });

  it('findNodesByNameSubstring (excludePrefix off): more out-of-focus substring rows than the limit, and the in-focus row is returned', () => {
    // Over 100 out-of-focus names hold "Widget". Without a focus, a kinds-only call with no language filter is
    // answered by the in-memory index; with a focus the SQL statement runs instead, because the index holds no paths.
    const options: SearchOptions & { excludePrefix?: boolean } = { kinds: ['function'], limit: 8, excludePrefix: false, pathPrefixes: FOCUS };
    const rows = widget.lookups.findNodesByNameSubstring('Widget', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderWidgetPanel']);
  });

  it('findNodesByNameSubstring (excludePrefix on): the same, with the prefix matches removed', () => {
    const options: SearchOptions & { excludePrefix?: boolean } = { kinds: ['function'], limit: 8, excludePrefix: true, pathPrefixes: FOCUS };
    const rows = widget.lookups.findNodesByNameSubstring('Widget', options);
    expect(rows.map((r) => r.node.name)).toEqual(['renderWidgetPanel']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The prefix SQL itself: wildcard characters, case and non-BMP characters in a path
// ---------------------------------------------------------------------------------------------------------------

describe('the prefix SQL is exact (paths repository)', () => {
  const files = (rows: Array<{ node: { filePath: string } }>): string[] => rows.map((r) => r.node.filePath).sort();

  it('precondition: with no prefix every directory holds a pathVector', () => {
    expect(files(paths.lookups.findNodesByExactName(['pathVector']))).toEqual(PATH_DIRS.map((d) => `${d}/v.ts`).sort());
  });

  it.each(PATH_DIRS)('findNodesByNameSubstring and findNodesByExactName under [%s] return only that directory', (dir) => {
    const options: SearchOptions & { excludePrefix?: boolean } = { kinds: ['function'], pathPrefixes: [dir] };
    expect(files(paths.lookups.findNodesByNameSubstring('pathVector', options))).toEqual([`${dir}/v.ts`]);
    expect(files(paths.lookups.findNodesByExactName(['pathVector'], { pathPrefixes: [dir] }))).toEqual([`${dir}/v.ts`]);
  });

  it('a prefix that differs from a directory in case alone matches nothing', () => {
    const options: SearchOptions & { excludePrefix?: boolean } = { kinds: ['function'], pathPrefixes: ['src/q_b'] };
    expect(files(paths.lookups.findNodesByNameSubstring('pathVector', options))).toEqual([]);
    expect(files(paths.lookups.findNodesByExactName(['pathVector'], { pathPrefixes: ['src/q_b'] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Segment lookups: the co-occurrence query and the single-word tier
// ---------------------------------------------------------------------------------------------------------------

describe('segment lookups under pathPrefixes (segments repository)', () => {
  it('fixture precondition: "widget" is in 21 names, inside the 2..25 names that tier B of getSegmentMatches considers', () => {
    const counts = segments.lookups.getSegmentNameCounts(['widget']);
    expect(counts.get('widget')).toBe(21);
  });

  it('getSegmentCoOccurrence: more than 24 out-of-focus co-occurring names, and the in-focus one is returned', () => {
    // 28 names hold "render" and "panel". Ordered by matches then length: 27 out-of-focus names (up to 16 characters)
    // come before renderWidgetPanel (17), so without a filter the LIMIT of 24 is full of out-of-focus names.
    const variants = [{ segment: 'render', word: 'render' }, { segment: 'panel', word: 'panel' }];
    const rows = segments.lookups.getSegmentCoOccurrence(variants, 2, 24, FOCUS);
    expect(rows.map((r) => r.name)).toEqual(['renderWidgetPanel']);
  });

  it('getNamesForSegment: a limit of 12 over the 21 names of tier B still returns the in-focus name', () => {
    // 20 out-of-focus names are shorter than renderWidgetPanel, so without a filter the 12 shortest are all out of focus.
    expect(segments.lookups.getNamesForSegment('widget', 12, FOCUS)).toEqual(['renderWidgetPanel']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Seed path: getSegmentMatches caps at 8, and the seeds come from the focus
// ---------------------------------------------------------------------------------------------------------------

describe('seed path under pathPrefixes (segments repository)', () => {
  it('getSegmentMatches: more than 8 out-of-focus seed candidates, and the in-focus name is seeded', () => {
    const names = segments.cg.getSegmentMatches(['widget'], 8, FOCUS).map((m) => m.name);
    expect(names).toEqual(['renderWidgetPanel']);
  });

  it('getSegmentMatches tier B: the two segments taken are the rarest that have an in-focus name', () => {
    const words = ['alpha', 'bravo', 'charlie'];
    // Fixture precondition: the whole-index counts make alpha and bravo the two rarest, ahead of charlie.
    const counts = tierB.lookups.getSegmentNameCounts(words);
    expect([counts.get('alpha'), counts.get('bravo'), counts.get('charlie')]).toEqual([2, 2, 3]);
    // Unfocused, the two rarest segments are alpha and bravo: charlie's names are not seeded.
    const unfocused = tierB.cg.getSegmentMatches(words, 8).map((m) => m.name).sort();
    expect(unfocused).toEqual(['barAlpha', 'barBravo', 'fooAlpha', 'fooBravo']);
    // Focused on src/app, alpha and bravo have no in-focus name, so charlie is taken and fooCharlie is returned.
    const focused = tierB.cg.getSegmentMatches(words, 8, FOCUS).map((m) => m.name);
    expect(focused).toEqual(['fooCharlie']);
  });

  it('findRelevantContext hands the context builder seeds drawn from the focus', async () => {
    // CodeGraph.findRelevantContext computes seedNames from getSegmentMatches and passes them down; spy on that hand-off.
    const builder = (segments.cg as unknown as { contextBuilder: { findRelevantContext: (...args: unknown[]) => unknown } })
      .contextBuilder;
    const spy = vi.spyOn(builder, 'findRelevantContext');
    try {
      const focus: FindRelevantContextOptions = { pathPrefixes: FOCUS };
      await segments.cg.findRelevantContext('widget', focus);
      const seeds = (spy.mock.calls[0]?.[1] as { seedNames?: string[] } | undefined)?.seedNames ?? [];
      expect(seeds).toEqual(['renderWidgetPanel']);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Parity: inPathPrefixes (the queries rule) against the host's inFocus
// ---------------------------------------------------------------------------------------------------------------

/**
 * Each row: the index path, the prefixes, and the answer both rules must give. The answers are the host's, as
 * written down: `inFocus` decides them, and the truth table below pins that decision.
 */
const PARITY: Array<[string, string[], boolean]> = [
  ['src/app', ['src/app'], true],
  ['src/app/x.ts', ['src/app'], true],
  ['src/application/x.ts', ['src/app'], false],
  ['src/appx', ['src/app'], false],
  ['SRC/app/x.ts', ['src/app'], false],
  ['src/app/x.ts', ['src/app/'], false],
  ['src/app/x.ts', [''], false],
  ['src/app/a/b.ts', ['src/app'], true],
  ['src/app/a/b.ts', ['src/app/a'], true],
  ['src/app/a/b.ts', ['src/lib', 'src/app'], true],
  ['src/lib/x.ts', ['src/lib', 'src/app'], true],
  ['src/other/x.ts', ['src/lib', 'src/app'], false],
  ['src/app', ['src/app/x.ts'], false],
  ['src/app/x.ts', ['src/app/x.ts'], true],
];

describe('inPathPrefixes parity with the host inFocus rule', () => {
  it('the host rule gives the truth table below (pins the rule the queries code must match)', () => {
    for (const [file, prefixes, expected] of PARITY) {
      expect(inFocus(file, prefixes), `inFocus(${JSON.stringify(file)}, ${JSON.stringify(prefixes)})`).toBe(expected);
    }
  });

  it('inPathPrefixes gives the same answer as inFocus for every non-empty list', () => {
    for (const [file, prefixes] of PARITY) {
      expect(inPathPrefixes(file, prefixes), `inPathPrefixes(${JSON.stringify(file)}, ${JSON.stringify(prefixes)})`).toBe(
        inFocus(file, prefixes),
      );
    }
  });

  it('the one named divergence: an empty list is no filter for inPathPrefixes, and matches nothing for inFocus', () => {
    expect(inFocus('src/app/x.ts', [])).toBe(false);
    expect(inPathPrefixes('src/app/x.ts', [])).toBe(true);
  });
});
