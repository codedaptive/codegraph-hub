/**
 * Unit tests for the session focus in explore's recall: `cg.findRelevantContext` takes `pathPrefixes`, and the
 * explore handler decides what it asks for by the focus in this index.
 *
 * - No focus: the recall gets the options it always gets, with no `pathPrefixes` key (U3).
 * - A focus with no directory inside this index: the recall is not asked. The answer is the sentence that names
 *   the focus and how to widen the call (U1).
 * - A focus with directories inside this index: the recall is asked once, with those directories as
 *   `pathPrefixes` (U2). When that recall leaves nothing in focus, one unfocused recall decides the answer: a hit
 *   outside the focus gives the nothing-in-focus sentence (U4), and no hit gives the usual "No relevant code found"
 *   answer (U5).
 *
 * The index is a stub. The handler reads the methods it reaches: `getProjectRoot` returns the test's root,
 * `getStats` reports two files, and the others return empty results. The recall is a spy that records the options
 * of every call. Focus directories are real directories, and each test's worktree has a `.git` entry at its top,
 * so the focus resolves against the filesystem as it does in a real worktree (`focusPrefixesForIndex`). The
 * nested-index case (U1) puts the index one level below the worktree root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type CodeGraph from '../../../src/index';
import type { Node, Subgraph } from '../../../src/types';
import { ToolHandler, focusPrefixesOfCall } from '../../../src/mcp/tools';
import { SESSION_FOCUS_ARG } from '../../../src/extensions/host/server/session-scope';

/** The sentence an explore with nothing inside the focus answers with, for the focus directories `dirs`. */
function nothingInFocus(dirs: string): string {
  return `No results inside this session's focus (${dirs}). Pass scope: "repo" to search the whole repository.`;
}

type RecallOptions = Record<string, unknown>;

interface StubIndex {
  /** The index handle the handler is given. */
  cg: CodeGraph;
  /** One copy per recall call, in call order, with every key the call's options had (a key holding undefined too). */
  recallCalls: RecallOptions[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A worktree for one test: a real temp directory (realpath'd, since macOS /var is a symlink into /private) with a
 * `.git` entry at its top. `worktreeRootOf` finds that entry, and repo-relative focus entries resolve against it.
 */
function worktree(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-focus-recall-unit-')));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

/** Makes each directory under `root` (repo-relative) and returns `root`. */
function withDirs(root: string, rels: string[]): string {
  for (const rel of rels) fs.mkdirSync(path.join(root, rel), { recursive: true });
  return root;
}

/**
 * An index stub rooted at `root`. The recall answers with `recall(options, callNumber)`. A call that throws is
 * still recorded first, so a test can count a call the handler should not have made.
 */
function stubIndex(root: string, recall: (options: RecallOptions, call: number) => Subgraph): StubIndex {
  const recallCalls: RecallOptions[] = [];
  const cg = {
    getProjectRoot: () => root,
    getStats: () => ({ fileCount: 2, nodeCount: 2 }),
    // Read by the empty-answer branch and by the seeding stages that run after a focus cut.
    getExploreMissDiagnostics: () => ({ matched: [], unmatched: [], candidates: [], limited: false }),
    getUnseenNames: () => [],
    findNamedCopybooks: () => [],
    getProjectNameTokens: () => new Set<string>(),
    getNodesByName: () => [],
    getNodesByNameSubstring: () => [],
    getNodesInFile: () => [],
    getNode: () => undefined,
    getCallers: () => [],
    getCallees: () => [],
    getIncomingEdges: () => [],
    findRelevantContext: async (_query: string, options: RecallOptions) => {
      recallCalls.push({ ...options });
      return recall(options, recallCalls.length);
    },
  };
  return { cg: cg as unknown as CodeGraph, recallCalls };
}

/** A recall answer with nothing in it. */
function noSubgraph(): Subgraph {
  return { nodes: new Map(), edges: [], roots: [] };
}

/** A recall answer holding one function, `id`, defined in `filePath`. */
function subgraphWith(id: string, filePath: string): Subgraph {
  const node = { id, kind: 'function', name: id, qualifiedName: id, filePath, language: 'typescript', startLine: 1, endLine: 1 };
  return { nodes: new Map([[id, node as unknown as Node]]), edges: [], roots: [id] };
}

/** One explore call through the handler's execute path. `toolAllowlist: null` allows every tool. */
function explore(stub: StubIndex, args: Record<string, unknown>) {
  return new ToolHandler(stub.cg).execute('codegraph_explore', args, undefined, { toolAllowlist: null });
}

/** Whether the recorded options have a `pathPrefixes` key, even one holding undefined. */
function hasPathPrefixes(options: RecallOptions | undefined): boolean {
  return options !== undefined && Object.prototype.hasOwnProperty.call(options, 'pathPrefixes');
}

describe('explore recall with a session focus', () => {
  it('U1: a focus with no directory in this index answers the nothing-in-focus sentence and never asks the recall', async () => {
    // The index is the nested checkout `sub`. The focus entry `other` is a directory of the worktree outside it.
    const root = withDirs(worktree(), ['sub', 'other']);
    const stub = stubIndex(path.join(root, 'sub'), () => {
      throw new Error('the recall ran for a focus with no directory in this index');
    });

    const result = await explore(stub, { query: 'widget', [SESSION_FOCUS_ARG]: ['other'] });

    expect(result.content[0].text).toContain(nothingInFocus('other'));
    expect(result.isError).toBeFalsy();
    expect(stub.recallCalls).toHaveLength(0);
  });

  it('U2: a focus with directories in this index asks the recall once, with those directories as pathPrefixes', async () => {
    const root = withDirs(worktree(), ['src/app']);
    const stub = stubIndex(root, () => subgraphWith('appFocusFn', 'src/app/app.ts'));
    const args = { query: 'widget', [SESSION_FOCUS_ARG]: ['src/app'] };
    const expected = focusPrefixesOfCall(stub.cg, args, true);
    expect(expected).toEqual(['src/app']);

    // The answer the handler renders from this recall is not asserted here; only the recall's options are.
    await explore(stub, args);

    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]?.pathPrefixes).toEqual(expected);
  });

  it('U3: with no focus the recall gets no pathPrefixes key', async () => {
    const stub = stubIndex(worktree(), () => noSubgraph());

    await explore(stub, { query: 'widget' });

    expect(stub.recallCalls).toHaveLength(1);
    expect(hasPathPrefixes(stub.recallCalls[0])).toBe(false);
  });

  it('U4: when the focused recall finds nothing in focus, one unfocused recall decides; an out-of-focus hit gives the sentence', async () => {
    const root = withDirs(worktree(), ['src/app', 'src/lib']);
    // The focused recall (the one with pathPrefixes) finds nothing. The unfocused one finds only a src/lib symbol.
    const stub = stubIndex(root, (options) =>
      hasPathPrefixes(options) ? noSubgraph() : subgraphWith('buildWidget01', 'src/lib/widget01.ts'));

    const result = await explore(stub, { query: 'widget', [SESSION_FOCUS_ARG]: ['src/app'] });

    expect(result.content[0].text).toContain(nothingInFocus('src/app'));
    expect(result.isError).toBeFalsy();
    expect(stub.recallCalls).toHaveLength(2);
    expect(stub.recallCalls[0]?.pathPrefixes).toEqual(['src/app']);
    expect(hasPathPrefixes(stub.recallCalls[1])).toBe(false);
  });

  it('U5: when neither recall finds anything, the usual no-result answer follows two recalls', async () => {
    const root = withDirs(worktree(), ['src/app']);
    const stub = stubIndex(root, () => noSubgraph());

    const result = await explore(stub, { query: 'widget', [SESSION_FOCUS_ARG]: ['src/app'] });

    expect(result.content[0].text.startsWith('No relevant code found')).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(stub.recallCalls).toHaveLength(2);
    expect(stub.recallCalls[0]?.pathPrefixes).toEqual(['src/app']);
    expect(hasPathPrefixes(stub.recallCalls[1])).toBe(false);
  });
});
