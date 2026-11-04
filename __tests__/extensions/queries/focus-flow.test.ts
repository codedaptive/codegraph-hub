/**
 * Focus flow: the path focus (`pathPrefixes`) applied to the call path among a query's named symbols, and to the
 * symbol lookups beneath it, so that a caller of the flow search can draw its path from in-focus symbols only.
 * codegraph_explore does not pass the focus yet (src/mcp/tools.ts:4239): it still finds the unfocused chain and
 * drops it whole when a step leaves the focus.
 *
 * The focus rule is the one `inPathPrefixes` states (src/db/queries.ts): a prefix is index-relative, and it matches a
 * path that equals it or lies below it, on whole segments, case-sensitively. An absent, undefined or empty list is no
 * filter: the answer is then the unfocused one, identical in every field of the flow.
 *
 * With a non-empty list:
 * - only in-focus symbols are resolved (the named set and the nodes each token resolves to);
 * - the walks, named and directed, never step onto an out-of-focus node. In named mode a seed's chain is the deepest
 *   one whose every step is in focus; in directed mode it is the path the two-ended walk finds, using in-focus nodes only.
 * - findAllSymbols and qualifiedSymbolMatches filter by the focus BEFORE their 50-row cap, and the did-you-mean note
 *   names only in-focus symbols.
 *
 * Two repositories, each indexed once in beforeAll:
 * - flow: the defect-1 repository (its files are inlined in flowFiles() below), with two additions:
 *   src/application/side.ts (sideHop, which calls tailMid across the focus boundary) and entryB in src/app/app.ts
 *   (which calls sideHop). Unfocused, entryB reaches tailMid and tailEnd through sideHop; focused, nothing from entryB
 *   is in focus to walk to.
 * - cap: 60 files src/lib/fNN.ts and src/zed/z.ts, each `export class Ctx` with a `next` method. Every Ctx.next row
 *   has the same text except zed's, whose `next` takes one parameter, so its indexed signature is two tokens longer
 *   (`extra`, `number`) and BM25 ranks it below the other 60. The 50-row cap then leaves it out when unfocused, whatever
 *   order the index keeps for equal rows; the focus has to bring it back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { findAllSymbols, resolveNamedSymbolFlow, resolveNamedTokens } from '../../../src/graph/named-symbol-flow';
import type { NamedSymbolFlow, NamedSymbolFlowOptions } from '../../../src/graph/named-symbol-flow';
import { qualifiedSymbolMatches } from '../../../src/graph/symbol-lookup';
import type { Edge, Node } from '../../../src/types';

const FOCUS = ['src/app'];
const ZED = ['src/zed'];

interface Repo {
  root: string;
  cg: CodeGraph;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

/**
 * The defect-1 repository, unchanged except that app.ts also imports sideHop, plus sideHop (src/application) and
 * entryB (src/app, calls sideHop).
 */
function flowFiles(): Record<string, string> {
  return {
    'src/app/app.ts':
      "import { sideHop } from '../application/side';\n" +
      "import { libBridge, libHop } from '../lib/lib';\n" +
      'export function startOrder(): string { return libBridge(); }\n' +
      'export function finishOrder(): string { return "done"; }\n' +
      'export function stepTwo(): string { return "two"; }\n' +
      'export function stepOne(): string { return stepTwo(); }\n' +
      'export function tailEnd(): string { return "end"; }\n' +
      'export function tailMid(): string { return tailEnd(); }\n' +
      'export function entry(): string { stepOne(); return libHop(); }\n' +
      'export function entryB(): string { return sideHop(); }\n',
    'src/lib/lib.ts':
      "import { finishOrder, tailMid } from '../app/app';\n" +
      'export function libBridge(): string { return finishOrder(); }\n' +
      'export function libHop(): string { return tailMid(); }\n',
    'src/application/side.ts':
      "import { tailMid } from '../app/app';\n" +
      'export function sideHop(): string { return tailMid(); }\n',
  };
}

/** 60 out-of-focus `Ctx.next` methods, then zed's, which takes one parameter (see the header). */
function capFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0');
    files[`src/lib/f${n}.ts`] = 'export class Ctx { next(): void {} }\n';
  }
  files['src/zed/z.ts'] = 'export class Ctx { next(extra: number): void {} }\n';
  return files;
}

async function openRepo(files: Record<string, string>): Promise<Repo> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-focus-flow-')));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const cg = await CodeGraph.init(root, { index: true });
  return { root, cg };
}

function closeRepo(repo: Repo | undefined): void {
  repo?.cg.close();
  if (repo) fs.rmSync(repo.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

let flowRepo: Repo;
let capRepo: Repo;

beforeAll(async () => {
  flowRepo = await openRepo(flowFiles());
  capRepo = await openRepo(capFiles());
});

afterAll(() => {
  closeRepo(flowRepo);
  closeRepo(capRepo);
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const label = (n: Node): string => `${n.name}@${n.filePath}`;
const inApp = (filePath: string): boolean => filePath.startsWith('src/app/');
const namesOf = (nodes: Iterable<Node>): string[] => [...nodes].map((n) => n.name).sort();
/** The name of every step of every chain, chain by chain, in chain order. */
const chainNames = (flow: NamedSymbolFlow): string[][] => flow.chains.map((c) => c.steps.map((s) => s.node.name));

const nodeRow = (n: Node): string => `${n.id}|${n.name}|${n.filePath}|${n.startLine}`;
const edgeRow = (e: Edge): string =>
  `${e.source}>${e.target}|${e.kind}|${e.line ?? ''}|${e.column ?? ''}|${e.provenance ?? ''}`;

/**
 * Every field of a flow as plain data. Maps and Sets become sorted rows, so the comparison does not depend on the order
 * a Map was filled in. Chains keep their order: best first is part of the answer. Edges are compared by their ends,
 * kind, line, column and provenance, and call sites by node id and line.
 */
function serialize(flow: NamedSymbolFlow): unknown {
  return {
    tokens: flow.tokens,
    named: [...flow.named.values()].map(nodeRow).sort(),
    dynNamed: [...flow.dynNamed.values()].map(nodeRow).sort(),
    tokenNodes: [...flow.tokenNodes].map(([t, ids]) => `${t}:${[...ids].sort().join(',')}`).sort(),
    tokenFamily: [...flow.tokenFamily].map(([t, ns]) => `${t}:${ns.map((n) => n.id).sort().join(',')}`).sort(),
    uniqueNamedNodeIds: [...flow.uniqueNamedNodeIds].sort(),
    preciseNamedIds: [...flow.preciseNamedIds].sort(),
    chains: flow.chains.map((c) => ({
      steps: c.steps.map((s) => ({ node: nodeRow(s.node), edge: s.edge ? edgeRow(s.edge) : null })),
      callSites: [...c.callSites].map(([id, line]) => `${id}@${line}`).sort(),
    })),
  };
}

const QUERY_CROSSING = 'startOrder finishOrder';
const QUERY_DEEP = 'entry stepOne stepTwo tailMid tailEnd';
const QUERY_SIBLING = 'entryB tailMid tailEnd';
const DIRECTED: NamedSymbolFlowOptions = { mode: 'directed', from: 'startOrder', to: 'finishOrder' };

// ---------------------------------------------------------------------------------------------------------------
// Pins: without a focus the answer is the unfocused one, in every empty form
// ---------------------------------------------------------------------------------------------------------------

describe('without a focus the call path is unchanged (flow repository)', () => {
  it('startOrder finishOrder: the chain is startOrder, libBridge, finishOrder, and the three unfocused forms give one flow', () => {
    const absent = resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING);
    expect(chainNames(absent)).toEqual([['startOrder', 'libBridge', 'finishOrder']]);
    const emptyOptions: NamedSymbolFlowOptions = {};
    const emptyList: NamedSymbolFlowOptions = { pathPrefixes: [] };
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, emptyOptions))).toEqual(serialize(absent));
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, emptyList))).toEqual(serialize(absent));
  });

  it('entry stepOne stepTwo tailMid tailEnd: the chain is entry, libHop, tailMid, tailEnd, and the three unfocused forms give one flow', () => {
    const absent = resolveNamedSymbolFlow(flowRepo.cg, QUERY_DEEP);
    expect(chainNames(absent)).toEqual([['entry', 'libHop', 'tailMid', 'tailEnd']]);
    const emptyOptions: NamedSymbolFlowOptions = {};
    const emptyList: NamedSymbolFlowOptions = { pathPrefixes: [] };
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_DEEP, emptyOptions))).toEqual(serialize(absent));
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_DEEP, emptyList))).toEqual(serialize(absent));
  });

  it('entryB tailMid tailEnd: unfocused, the chain runs through src/application by way of sideHop', () => {
    // This is the route the focused sibling test must not find: the unfocused call reaches it.
    const absent = resolveNamedSymbolFlow(flowRepo.cg, QUERY_SIBLING);
    expect(chainNames(absent)).toEqual([['entryB', 'sideHop', 'tailMid', 'tailEnd']]);
    const emptyList: NamedSymbolFlowOptions = { pathPrefixes: [] };
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_SIBLING, emptyList))).toEqual(serialize(absent));
  });

  it('directed startOrder to finishOrder: the chain is startOrder, libBridge, finishOrder, and an empty list gives the same flow', () => {
    const absent = resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, DIRECTED);
    expect(chainNames(absent)).toEqual([['startOrder', 'libBridge', 'finishOrder']]);
    const emptyList: NamedSymbolFlowOptions = { ...DIRECTED, pathPrefixes: [] };
    expect(serialize(resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, emptyList))).toEqual(serialize(absent));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The named walk and the named resolution under a focus
// ---------------------------------------------------------------------------------------------------------------

describe('the named call path under a focus (flow repository)', () => {
  it('the walk never steps onto src/lib: entry, stepOne, stepTwo is the deepest chain whose every step is in focus', () => {
    const focused = resolveNamedSymbolFlow(flowRepo.cg, QUERY_DEEP, { pathPrefixes: FOCUS });
    expect(focused.chains.length).toBeGreaterThan(0);
    expect(chainNames(focused)[0]).toEqual(['entry', 'stepOne', 'stepTwo']);
    for (const step of focused.chains[0]!.steps) {
      expect(inApp(step.node.filePath), `${label(step.node)} is outside src/app`).toBe(true);
    }
  });

  it('a route that crosses the focus boundary is not found: startOrder and finishOrder are named, and no chain connects them', () => {
    const focused = resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, { pathPrefixes: FOCUS });
    expect(namesOf(focused.named.values())).toEqual(['finishOrder', 'startOrder']);
    expect(chainNames(focused)).toEqual([]);
  });

  it('a sibling directory that shares the letters of the focus stays out: entryB reaches nothing in src/app through sideHop', () => {
    const focused = resolveNamedSymbolFlow(flowRepo.cg, QUERY_SIBLING, { pathPrefixes: FOCUS });
    const steps = focused.chains.flatMap((c) => c.steps.map((s) => s.node));
    expect(steps.map((n) => n.name)).not.toContain('sideHop');
    expect(steps.filter((n) => !inApp(n.filePath)).map(label)).toEqual([]);
    // entryB has no in-focus callee, so it starts no chain. tailMid -> tailEnd is an in-focus chain of its own, and it
    // is the one answer left: the deepest chain from tailMid whose every step is in focus.
    expect(chainNames(focused)).toEqual([['tailMid', 'tailEnd']]);
  });

  it('a prefix matches whole path segments: src/ap holds none of the flow, so nothing resolves', () => {
    const focused = resolveNamedSymbolFlow(flowRepo.cg, QUERY_DEEP, { pathPrefixes: ['src/ap'] });
    expect(focused.named.size).toBe(0);
    expect(focused.chains).toEqual([]);
  });

  it('resolveNamedTokens resolves only in-focus symbols: libBridge, which lives in src/lib, is not named', () => {
    const q = 'startOrder libBridge finishOrder';
    expect(namesOf(resolveNamedTokens(flowRepo.cg, q).named.values())).toEqual(['finishOrder', 'libBridge', 'startOrder']);
    const focused = resolveNamedTokens(flowRepo.cg, q, { pathPrefixes: FOCUS });
    expect(namesOf(focused.named.values())).toEqual(['finishOrder', 'startOrder']);
    expect(focused.tokenNodes.get('libBridge') ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The directed walk under a focus
// ---------------------------------------------------------------------------------------------------------------

describe('the directed call path under a focus (flow repository)', () => {
  it('from startOrder to finishOrder: with the focus, no chain, because the only route crosses src/lib', () => {
    const focused = resolveNamedSymbolFlow(flowRepo.cg, QUERY_CROSSING, { ...DIRECTED, pathPrefixes: FOCUS });
    expect(chainNames(focused)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// findAllSymbols and qualifiedSymbolMatches: the focus is applied before the 50-row cap
// ---------------------------------------------------------------------------------------------------------------

describe('findAllSymbols and qualifiedSymbolMatches under a focus (cap repository)', () => {
  it('fixture precondition: without a focus, the 50-row cap holds 50 rows and leaves out src/zed', () => {
    const rows = findAllSymbols(capRepo.cg, 'Ctx.next').nodes;
    expect(rows).toHaveLength(50);
    expect(rows.map((n) => n.filePath)).not.toContain('src/zed/z.ts');
  });

  it('findAllSymbols with a focus returns the in-focus next, although 60 out-of-focus rows rank ahead of it', () => {
    const { nodes } = findAllSymbols(capRepo.cg, 'Ctx.next', ZED);
    expect(nodes.map(label)).toEqual(['next@src/zed/z.ts']);
  });

  it('findAllSymbols with no list, and with an empty one, is still the unfocused 50-row answer', () => {
    expect(findAllSymbols(capRepo.cg, 'Ctx.next').nodes).toHaveLength(50);
    expect(findAllSymbols(capRepo.cg, 'Ctx.next', []).nodes).toHaveLength(50);
  });

  it('qualifiedSymbolMatches with a focus returns the in-focus next, every node of it inside src/zed', () => {
    const rows = qualifiedSymbolMatches(capRepo.cg, 'Ctx.next', undefined, ZED);
    expect(rows.map(label)).toEqual(['next@src/zed/z.ts']);
    expect(rows.every((n) => n.filePath.startsWith('src/zed/'))).toBe(true);
  });

  it('qualifiedSymbolMatches with no list, and with an empty one, returns the unfocused 50 rows', () => {
    expect(qualifiedSymbolMatches(capRepo.cg, 'Ctx.next')).toHaveLength(50);
    expect(qualifiedSymbolMatches(capRepo.cg, 'Ctx.next', undefined, [])).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The did-you-mean note under a focus
// ---------------------------------------------------------------------------------------------------------------

describe('the did-you-mean note under a focus (flow repository)', () => {
  it('without a focus, the note for the misspelt libBridg names libBridge, which lives in src/lib', () => {
    expect(findAllSymbols(flowRepo.cg, 'libBridg').note).toContain('libBridge');
  });

  it('with a focus, the note does not name libBridge, and no in-focus symbol matches libBridg', () => {
    const focused = findAllSymbols(flowRepo.cg, 'libBridg', FOCUS);
    expect(focused.nodes).toEqual([]);
    expect(focused.note).not.toContain('libBridge');
  });
});
