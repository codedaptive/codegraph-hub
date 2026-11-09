import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src';
import { __setLoadCodeGraphForTests, ToolHandler, type ToolResult } from '../../../src/mcp/tools';

const IDLE_MS = 1000;
const START = 1_000_000;
const SYMBOL = 'idleCloseKnownSymbol';

describe('project idle release during tool calls', () => {
  let workspace: string;
  let rootA: string;
  let rootX: string;
  let handler: ToolHandler;

  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-idle-call-')));
    rootA = path.join(workspace, 'a');
    rootX = path.join(workspace, 'x');
    for (const root of [rootA, rootX]) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'app.ts'), `export function ${SYMBOL}() { return 42; }\n`);
      const graph = await CodeGraph.init(root);
      try { await graph.indexAll(); } finally { graph.close(); }
    }
  });

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', String(IDLE_MS));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(null);
    handler.setReadOnly(true);
  });

  afterEach(async () => {
    await handler.closeAll();
    __setLoadCodeGraphForTests(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function holdSearch() {
    let resume = () => {};
    let opened = () => {};
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { opened = resolve; });
    const dispatch = handler['dispatchTool'].bind(handler);
    handler['dispatchTool'] = async (name, args) => {
      const graph = handler['getCodeGraph'](String(args.projectPath));
      const result = await dispatch(name, args);
      opened();
      await held;
      // A real read on the same connection after the pause exposes a mid-call close.
      graph.searchNodes(SYMBOL);
      return result;
    };
    return { ready, resume };
  }

  function search(root: string, mode: 'execute' | 'executeReadTool') {
    return handler[mode]('codegraph_search', { projectPath: root, query: SYMBOL });
  }

  async function waitForOpen(ready: Promise<void>, call: Promise<ToolResult>) {
    const outcome = await Promise.race([
      ready.then(() => null),
      call.then((result) => result),
    ]);
    expect(outcome, `the call must reach the held search: ${JSON.stringify(outcome)}`).toBeNull();
  }

  it('keeps a worker read alive when an idle trim runs mid-call', async () => {
    const hold = holdSearch();
    const call = search(rootA, 'executeReadTool');
    await waitForOpen(hold.ready, call);
    vi.setSystemTime(START + IDLE_MS + 1);
    handler.trimIdleProjects();
    hold.resume();
    const result = await call;
    expect(result.isError, 'idle trim must not close the database during the worker read').toBeFalsy();
    expect(result.content[0].text).toContain(SYMBOL);
  });

  it.each(['execute', 'executeReadTool'] as const)(
    'starts the idle deadline at the end of a long %s call',
    async (mode) => {
      const hold = holdSearch();
      const call = search(rootA, mode);
      await waitForOpen(hold.ready, call);
      vi.setSystemTime(START + IDLE_MS + 1);
      hold.resume();
      const result = await call;
      handler.trimIdleProjects();
      const openAtEnd = handler.isProjectRootOpen(rootA);
      vi.setSystemTime(START + 2 * IDLE_MS + 2);
      handler.trimIdleProjects();
      expect(result.isError).toBeFalsy();
      expect(openAtEnd, 'the idle clock must start at call completion').toBe(true);
      expect(handler.isProjectRootOpen(rootA), 'the project must close after its new idle deadline').toBe(false);
    },
  );

  it('moves the last completed root behind an older root in idle order', async () => {
    expect((await search(rootA, 'executeReadTool')).isError).toBeFalsy();
    vi.setSystemTime(START + 100);
    expect((await search(rootX, 'executeReadTool')).isError).toBeFalsy();
    vi.setSystemTime(START + 200);
    const hold = holdSearch();
    const call = search(rootA, 'executeReadTool');
    await waitForOpen(hold.ready, call);
    vi.setSystemTime(START + 800);
    hold.resume();
    const result = await call;
    vi.setSystemTime(START + 1201);
    handler.trimIdleProjects();
    const xOpen = handler.isProjectRootOpen(rootX);
    const aOpen = handler.isProjectRootOpen(rootA);
    vi.setSystemTime(START + 1801);
    handler.trimIdleProjects();
    expect(result.isError).toBeFalsy();
    expect(xOpen, 'the earlier completed root must close first').toBe(false);
    expect(aOpen, 'the last completed root must remain open until its own deadline').toBe(true);
    expect(handler.isProjectRootOpen(rootA), 'the last completed root must eventually close').toBe(false);
  });

  it('waits for a worker read before releasing its project root', async () => {
    const hold = holdSearch();
    const call = search(rootA, 'executeReadTool');
    await waitForOpen(hold.ready, call);
    let released = false;
    const release = handler.releaseProjectRoot(rootA).then(() => { released = true; });
    await Promise.resolve();
    const releasedDuringCall = released;
    hold.resume();
    const result = await call;
    await release;
    expect(releasedDuringCall, 'releaseProjectRoot must wait for the worker call').toBe(false);
    expect(result.isError, 'the worker call must answer before its database is closed').toBeFalsy();
    expect(result.content[0].text).toContain(SYMBOL);
    expect(handler.isProjectRootOpen(rootA), 'the root must be closed after release').toBe(false);
  });
});
