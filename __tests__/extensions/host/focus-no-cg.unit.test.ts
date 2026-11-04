/**
 * Regression test: a call whose session has no focus must not read the index handle for focus. The handler's
 * count is exactly one, not zero: the worktree notice (`withWorktreeNotice` -> `worktreeMismatchFor`) reads
 * `getProjectRoot` once and catches the failure. A focus read on top of it would make two.
 */
import { describe, expect, it } from 'vitest';
import type CodeGraph from '../../../src/index';
import { ToolHandler, focusPrefixesOfCall } from '../../../src/mcp/tools';
import { SESSION_FOCUS_ARG } from '../../../src/extensions/host/server/session-scope';

/** A handle whose every property read throws, so a test can tell the helper read it. */
function touchTrap(): Pick<CodeGraph, 'getProjectRoot'> {
  return new Proxy({}, {
    get() {
      throw new Error('cg touched');
    },
  }) as Pick<CodeGraph, 'getProjectRoot'>;
}

describe('focusPrefixesOfCall on a session with no focus', () => {
  it('search and explore with no scope answer null without reading the handle', () => {
    expect(focusPrefixesOfCall(touchTrap(), {}, true)).toBeNull();
  });

  it('search and explore with scope "focus" answer null without reading the handle', () => {
    expect(focusPrefixesOfCall(touchTrap(), { scope: 'focus' }, true)).toBeNull();
  });

  it('callers and impact answer null without reading the handle', () => {
    expect(focusPrefixesOfCall(touchTrap(), {}, false)).toBeNull();
  });

  it('scope "repo" answers null without reading the handle', () => {
    expect(focusPrefixesOfCall(touchTrap(), { scope: 'repo' }, true)).toBeNull();
  });
});

describe('focusPrefixesOfCall with a focus (positive controls)', () => {
  const focused = { [SESSION_FOCUS_ARG]: ['src'] };

  it('search and explore read the handle for the focus', () => {
    expect(() => focusPrefixesOfCall(touchTrap(), focused, true)).toThrow('cg touched');
  });

  it('callers and impact read the handle for the focus', () => {
    expect(() => focusPrefixesOfCall(touchTrap(), focused, false)).toThrow('cg touched');
  });
});

describe('ToolHandler on a session with no focus', () => {
  /** An index stub with the reads the focusless read tools make, and a counter on `getProjectRoot`. */
  function indexStub() {
    let rootReads = 0;
    const cg = {
      searchNodes: () => [],
      getNodesByName: () => [],
      getFile: () => undefined,
      generatedFilePredicate: () => () => false,
      getProjectRoot: () => {
        rootReads++;
        throw new Error('cg touched');
      },
    };
    return { cg, rootReads: () => rootReads };
  }

  // `toolAllowlist: null` is a session told it has no allowlist: every tool is allowed, whatever this
  // process's CODEGRAPH_MCP_TOOLS says, so the environment cannot turn these calls into a different failure.
  const options = { toolAllowlist: null };

  it('codegraph_search answers "No results found" and reads the root once, for the worktree notice', async () => {
    const stub = indexStub();
    const handler = new ToolHandler(stub.cg as unknown as CodeGraph);

    const result = await handler.execute('codegraph_search', { query: 'x' }, undefined, options);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No results found');
    expect(stub.rootReads()).toBe(1);
  });

  it('codegraph_callers answers "not found" and reads the root once, for the worktree notice', async () => {
    const stub = indexStub();
    const handler = new ToolHandler(stub.cg as unknown as CodeGraph);

    const result = await handler.execute('codegraph_callers', { symbol: 'plainName' }, undefined, options);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('not found');
    expect(stub.rootReads()).toBe(1);
  });

  it('codegraph_impact answers "not found" and reads the root once, for the worktree notice', async () => {
    const stub = indexStub();
    const handler = new ToolHandler(stub.cg as unknown as CodeGraph);

    const result = await handler.execute('codegraph_impact', { symbol: 'plainName' }, undefined, options);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('not found');
    expect(stub.rootReads()).toBe(1);
  });
});
