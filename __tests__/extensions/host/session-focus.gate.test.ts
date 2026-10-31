/**
 * Session-focus gates: `serve --mcp --focus <dir>` over stdio, as an agent host runs it, against throwaway git
 * repositories with CODEGRAPH_STATE_DIR set per test.
 *
 * The repository has src/app (the focus) and src/lib (outside it), with calls across the two, so each gate has
 * results on both sides of the focus:
 * - G1: search and explore stay inside the focus; scope "repo" brings the outside back.
 * - G2: callers and impact list every caller; the out-of-focus ones sit under "## Outside focus (" after the
 *   in-focus ones.
 * - G3: node, callees, files and status answer the same in focus as without it.
 * - G4: the tool list and the tool call are per session. The server takes its environment from its first client,
 *   so each session's own CODEGRAPH_MCP_TOOLS decides what it lists and what it may call, in either start order.
 *   An unfocused session also gets unfiltered search results beside a focused one.
 * - G5: an extension tool's context carries the session's focus; a wire argument cannot set it.
 * - G6: `serve --mcp` refuses an absolute or escaping --focus before it serves.
 * - G7: a --focus naming a symlink that leaves the repository is dropped, not trusted: the session still filters by
 *   its other --focus entries.
 * - G8: --focus is relative to the repository root, not to the launch worktree: calls on a sibling linked worktree
 *   are filtered by that worktree's own src/app, and its ctx.focus names it.
 *
 * The probe tool (`fixtures/focus-probe-extension.cjs`) reports the focus its context carries. The helpers are in
 * `machine-server.harness.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import {
  BIN,
  Fixtures,
  McpSession,
  ToolAnswer,
  answers,
  excerpt,
  gateEnv,
  serverPidOf,
  sleep,
  stopIfCodegraph,
} from './machine-server.harness';

const SEARCH = 'codegraph_search';
const EXPLORE = 'codegraph_explore';
const CALLERS = 'codegraph_callers';
const IMPACT = 'codegraph_impact';
const CALLEES = 'codegraph_callees';
const NODE = 'codegraph_node';
const FILES = 'codegraph_files';
const STATUS = 'codegraph_status';
/** The fixture extension tool, and its short name for CODEGRAPH_MCP_TOOLS. */
const PROBE = 'codegraph_focus_probe';
const PROBE_SHORT = 'focus_probe';
const FIXTURE = path.resolve(__dirname, 'fixtures/focus-probe-extension.cjs');
/** The built-in tools every focus session allows. */
const TOOLS = 'explore,search,callers,impact,node,callees,files,status';
const OUTSIDE_HEADING = '## Outside focus (';

const APP_MARKER = 'gate-app-body-marker';
const LIB_MARKER = 'gate-lib-body-marker';
const OUT_CALLER_MARKER = 'gate-out-caller-body-marker';

const APP_TS =
  "import { libOutsideFn } from '../lib/lib';\n" +
  `export function appFocusFn(): string { return libOutsideFn() + "${APP_MARKER}"; }\n` +
  'export function focusTarget(): string { return "gate-target-body-marker"; }\n' +
  `export function inFocusCaller(): string { return focusTarget() + "gate-in-caller-body-marker"; }\n`;
const LIB_TS =
  "import { focusTarget } from '../app/app';\n" +
  `export function libOutsideFn(): string { return "${LIB_MARKER}"; }\n` +
  `export function outsideCaller(): string { return focusTarget() + "${OUT_CALLER_MARKER}"; }\n`;

/** The focus repository, indexed by the CLI into `stateDir`. Returns its realpath. */
function focusRepo(fx: Fixtures, root: string, stateDir: string): string {
  const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/app/app.ts': APP_TS, 'src/lib/lib.ts': LIB_TS });
  fx.index(repo, stateDir);
  return repo;
}

/** The probe's report when the call was served, else null. */
interface ProbeReport {
  probe: string;
  focus: string[] | string;
  argKeys: string[];
}

function probeOf(ans: ToolAnswer): ProbeReport | null {
  if (ans.isError || ans.rpcError !== null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ans.text);
  } catch {
    return null;
  }
  const report = parsed as Partial<ProbeReport> | null;
  return report !== null && typeof report === 'object' && report.probe === 'FOCUS_PROBE' ? (report as ProbeReport) : null;
}

/**
 * One session's allowlist, checked both ways: its tool list shows the probe exactly when its own CODEGRAPH_MCP_TOOLS
 * names it, and a call to the probe is served exactly then. A refusal is an error answer that names
 * CODEGRAPH_MCP_TOOLS. A call that also carries a wire `__cgSessionTools` naming the opposite choice gets the same
 * answer: the wire argument changes nothing.
 */
async function checkAllowlist(
  label: string,
  session: McpSession,
  repo: string,
  allowsProbe: boolean,
  problems: string[],
): Promise<void> {
  const listed = (await session.listTools()).includes(PROBE);
  if (listed !== allowsProbe) problems.push(`${label} ${listed ? 'lists' : 'does not list'} ${PROBE}`);
  const plain = await session.tool(PROBE, { projectPath: repo });
  const wire = await session.tool(PROBE, {
    projectPath: repo,
    __cgSessionTools: allowsProbe ? ['explore'] : [PROBE_SHORT],
  });
  const calls: Array<[string, ToolAnswer]> = [
    ['call', plain],
    ['call with a wire __cgSessionTools argument', wire],
  ];
  for (const [kind, ans] of calls) {
    const served = probeOf(ans) !== null;
    if (served !== allowsProbe) {
      problems.push(`${label} ${kind} to ${PROBE} was ${served ? 'served' : 'not served'}; its allowlist ${allowsProbe ? 'names it' : 'does not'}: ${excerpt(ans)}`);
    } else if (!allowsProbe && !(ans.isError && ans.text.includes('CODEGRAPH_MCP_TOOLS'))) {
      problems.push(`${label} ${kind} to ${PROBE} was refused without naming CODEGRAPH_MCP_TOOLS: ${excerpt(ans)}`);
    }
  }
}

describe('session focus gates (serve --mcp --focus over stdio, throwaway repositories)', () => {
  const fx = new Fixtures();
  afterEach(() => fx.teardown(), 60_000);

  // G1: the focus filters search and explore. An in-focus symbol comes back with its source; an out-of-focus
  // symbol's path and source never do; scope "repo" brings the out-of-focus result back.
  it('G1: --focus src/app keeps search and explore inside src/app, and scope "repo" brings src/lib back', async () => {
    // Long by design: a CLI index run of the repository, a serve --mcp cold start
    // (each node process loads the wasm runtime), and six tool calls, the first of which reads the index cold.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const session = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env: { CODEGRAPH_MCP_TOOLS: TOOLS } });
    await session.initialize();

    const problems: string[] = [];
    const inApp = await session.tool(SEARCH, { query: 'appFocusFn', projectPath: repo });
    if (inApp.isError || !inApp.text.includes('src/app/app.ts')) {
      problems.push(`search for an in-focus symbol did not return src/app/app.ts: ${excerpt(inApp)}`);
    }
    const outSearch = await session.tool(SEARCH, { query: 'outsideCaller', projectPath: repo });
    // A search that finds nothing in focus is still a success-shaped answer, not an error.
    if (outSearch.isError || outSearch.rpcError !== null) {
      problems.push(`search for an out-of-focus symbol was an error, not a success-shaped answer: ${excerpt(outSearch)}`);
    }
    if (outSearch.text.includes('src/lib/')) {
      problems.push(`search in focus returned a src/lib result: ${excerpt(outSearch)}`);
    }
    const wideSearch = await session.tool(SEARCH, { query: 'outsideCaller', scope: 'repo', projectPath: repo });
    if (!wideSearch.text.includes('src/lib/lib.ts')) {
      problems.push(`search with scope "repo" did not return src/lib/lib.ts: ${excerpt(wideSearch)}`);
    }

    const inExplore = await session.tool(EXPLORE, { query: 'appFocusFn', projectPath: repo });
    if (!answers(inExplore, 'appFocusFn', APP_MARKER)) {
      problems.push(`explore for an in-focus symbol did not return its source: ${excerpt(inExplore)}`);
    }
    if (inExplore.text.includes('src/lib/') || inExplore.text.includes(LIB_MARKER)) {
      problems.push(`explore in focus showed a src/lib item (libOutsideFn is outside the focus): ${excerpt(inExplore)}`);
    }
    const outExplore = await session.tool(EXPLORE, { query: 'outsideCaller', projectPath: repo });
    if (outExplore.isError || outExplore.rpcError !== null) {
      problems.push(`explore for an out-of-focus symbol was an error, not a success-shaped answer: ${excerpt(outExplore)}`);
    }
    if (outExplore.text.includes(OUT_CALLER_MARKER) || outExplore.text.includes('src/lib/')) {
      problems.push(`explore in focus returned src/lib for an out-of-focus symbol: ${excerpt(outExplore)}`);
    }
    const wideExplore = await session.tool(EXPLORE, { query: 'outsideCaller', scope: 'repo', projectPath: repo });
    if (!answers(wideExplore, 'outsideCaller', OUT_CALLER_MARKER)) {
      problems.push(`explore with scope "repo" did not return the src/lib source: ${excerpt(wideExplore)}`);
    }

    expect(problems, 'G1 problems (empty when the focus filters search and explore, and scope "repo" widens them)').toEqual([]);
  }, 150_000);

  // G2: callers and impact cover the whole repository. The focused session lists the in-focus callers first, then
  // the out-of-focus ones under the heading; its counts cover the in-focus part only. An unfocused session on the
  // same server lists both with no heading.
  it('G2: callers and impact list every caller, out-of-focus ones after the Outside focus heading', async () => {
    // Long by design: a CLI index run, two serve --mcp sessions on one server (a
    // cold start), and four tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const env = { CODEGRAPH_MCP_TOOLS: TOOLS };
    const unfocused = fx.session({ cwd: repo, stateDir, env });
    await unfocused.initialize();
    const focused = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env });
    await focused.initialize();

    const problems: string[] = [];
    for (const [tool, wholeCount] of [[CALLERS, '(3 found)'], [IMPACT, 'affects 5 symbols']] as const) {
      const label = tool.replace('codegraph_', '');

      const all = await unfocused.tool(tool, { symbol: 'focusTarget', projectPath: repo });
      if (all.isError || !all.text.includes('inFocusCaller') || !all.text.includes('outsideCaller')) {
        problems.push(`${label} with no focus did not list both callers: ${excerpt(all)}`);
      }
      if (all.text.includes(OUTSIDE_HEADING)) {
        problems.push(`${label} with no focus has an Outside focus heading: ${excerpt(all)}`);
      }

      const inFocus = await focused.tool(tool, { symbol: 'focusTarget', projectPath: repo });
      if (inFocus.isError || !inFocus.text.includes('inFocusCaller') || !inFocus.text.includes('outsideCaller')) {
        problems.push(`${label} in focus did not list every caller: ${excerpt(inFocus)}`);
      }
      const at = inFocus.text.indexOf(OUTSIDE_HEADING);
      if (at === -1) {
        problems.push(`${label} in focus has no "${OUTSIDE_HEADING}" heading: ${excerpt(inFocus)}`);
        continue;
      }
      if (inFocus.text.indexOf('inFocusCaller') > at) {
        problems.push(`${label} in focus lists inFocusCaller after the Outside focus heading`);
      }
      if (inFocus.text.indexOf('outsideCaller') < at) {
        problems.push(`${label} in focus lists outsideCaller before the Outside focus heading`);
      }
      // The in-focus part and its counts cover the in-focus callers only: the whole-repository count must not
      // appear above the heading.
      if (inFocus.text.slice(0, at).includes(wholeCount)) {
        problems.push(`${label} in focus counts the whole repository ("${wholeCount}") above the heading`);
      }
    }

    expect(problems, 'G2 problems (empty when callers and impact list every caller, out-of-focus ones after the heading)').toEqual([]);
  }, 150_000);

  // G3: node, callees, files and status ignore the focus. The focused session's answers equal the unfocused one's
  // on the same server, and the out-of-focus items (a src/lib callee, the src/lib files) are still there.
  it('G3: node, callees, files and status answer the same in focus as unfocused, out-of-focus items included', async () => {
    // Long by design: a CLI index run, two sessions on one server (a cold start),
    // and ten tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const env = { CODEGRAPH_MCP_TOOLS: TOOLS };
    const unfocused = fx.session({ cwd: repo, stateDir, env });
    await unfocused.initialize();
    const focused = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env });
    await focused.initialize();

    const calls: Array<{ tool: string; args: Record<string, unknown>; mustContain: string }> = [
      { tool: NODE, args: { symbol: 'appFocusFn', includeCode: true }, mustContain: 'libOutsideFn' },
      { tool: CALLEES, args: { symbol: 'appFocusFn' }, mustContain: 'libOutsideFn' },
      { tool: FILES, args: {}, mustContain: 'lib.ts' },
      { tool: FILES, args: { path: 'src/lib' }, mustContain: 'lib.ts' },
      { tool: STATUS, args: {}, mustContain: 'Files indexed:** 2' },
    ];
    const problems: string[] = [];
    for (const { tool, args, mustContain } of calls) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const base = await unfocused.tool(tool, { ...args, projectPath: repo });
      const inFocus = await focused.tool(tool, { ...args, projectPath: repo });
      if (base.isError || base.rpcError !== null || !base.text.includes(mustContain)) {
        problems.push(`${label} with no focus did not answer with "${mustContain}": ${excerpt(base)}`);
      }
      if (inFocus.text !== base.text || inFocus.isError !== base.isError) {
        problems.push(`${label} differs in focus: ${excerpt(inFocus)} (no focus: ${excerpt(base)})`);
      } else if (!inFocus.text.includes(mustContain)) {
        problems.push(`${label} in focus dropped "${mustContain}": ${excerpt(inFocus)}`);
      }
    }

    expect(problems, 'G3 problems (empty when node, callees, files and status ignore the focus)').toEqual([]);
  }, 150_000);

  // G4: the tool list and the tool call come from each session's own CODEGRAPH_MCP_TOOLS. Each test starts the
  // server from one session and checks both sessions, so each direction is judged on its own.
  it('G4a: a later session that allows the probe lists and calls it on a server an earlier narrow session started', async () => {
    // Long by design: a CLI index run, two serve --mcp sessions (the first starts
    // the server cold), two tool lists and four tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const narrow = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: 'explore' },
    });
    await narrow.initialize();
    const allowing = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: `explore,${PROBE_SHORT}` },
    });
    await allowing.initialize();

    const problems: string[] = [];
    await checkAllowlist('the later session (explore, focus_probe)', allowing, repo, true, problems);
    await checkAllowlist('the earlier session (explore only)', narrow, repo, false, problems);

    expect(problems, 'G4a problems (empty when each session lists and calls only what its own allowlist names)').toEqual([]);
  }, 150_000);

  it('G4b: a later session without the probe is refused on a server an earlier allowing session started', async () => {
    // Long by design: a CLI index run, two serve --mcp sessions (the first starts
    // the server cold), two tool lists and four tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const allowing = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: `explore,${PROBE_SHORT}` },
    });
    await allowing.initialize();
    const narrow = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: 'explore' },
    });
    await narrow.initialize();

    const problems: string[] = [];
    await checkAllowlist('the earlier session (explore, focus_probe)', allowing, repo, true, problems);
    await checkAllowlist('the later session (explore only)', narrow, repo, false, problems);

    expect(problems, 'G4b problems (empty when each session lists and calls only what its own allowlist names)').toEqual([]);
  }, 150_000);

  it('G4c: an unfocused session gets unfiltered search results beside a focused one on the same server', async () => {
    // Long by design: a CLI index run, two serve --mcp sessions on one server (a
    // cold start), and four searches.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const env = { CODEGRAPH_MCP_TOOLS: 'explore,search' };
    const unfocused = fx.session({ cwd: repo, stateDir, env });
    await unfocused.initialize();

    const problems: string[] = [];
    const all = await unfocused.tool(SEARCH, { query: 'outsideCaller', projectPath: repo });
    if (!all.text.includes('src/lib/lib.ts')) {
      problems.push(`the unfocused search did not return src/lib/lib.ts: ${excerpt(all)}`);
    }
    // A wire argument naming the focus must not narrow an unfocused session.
    const wire = await unfocused.tool(SEARCH, {
      query: 'outsideCaller',
      projectPath: repo,
      __cgSessionFocus: [path.join(repo, 'src', 'app')],
    });
    if (!wire.text.includes('src/lib/lib.ts')) {
      problems.push(`a wire __cgSessionFocus narrowed the unfocused search: ${excerpt(wire)}`);
    }

    const focused = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env });
    const started = await focused.initialize().then(
      () => true,
      (err: unknown) => {
        problems.push(`the focused session did not start: ${(err as Error).message}`);
        return false;
      },
    );
    if (started) {
      const inApp = await focused.tool(SEARCH, { query: 'appFocusFn', projectPath: repo });
      if (!inApp.text.includes('src/app/app.ts')) {
        problems.push(`the focused search did not return src/app/app.ts: ${excerpt(inApp)}`);
      }
      const outside = await focused.tool(SEARCH, { query: 'outsideCaller', projectPath: repo });
      if (outside.text.includes('src/lib/')) {
        problems.push(`the focused search returned a src/lib result: ${excerpt(outside)}`);
      }
    }

    expect(problems, 'G4c problems (empty when the unfocused search is unfiltered and the focused one is filtered)').toEqual([]);
  }, 150_000);

  // G5: the extension tool's context carries the session focus resolved for the call's worktree: the absolute
  // canonical focus dir for a focused session, [] for an unfocused one. --focus is relative to the repository root, so a session launched in src/lib
  // gets the same focus. Wire arguments cannot set it, and the extension never receives the internal keys.
  it('G5: an extension tool context carries the session focus, and a wire argument cannot set it', async () => {
    // Long by design: a CLI index run, three serve --mcp sessions on one server (a
    // cold start), and five tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const env = { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: `${TOOLS},${PROBE_SHORT}` };
    const focused = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env });
    await focused.initialize();
    const unfocused = fx.session({ cwd: repo, stateDir, env });
    await unfocused.initialize();
    const fromLib = fx.session({ cwd: path.join(repo, 'src', 'lib'), stateDir, args: ['--focus', 'src/app'], env });
    await fromLib.initialize();

    const appDir = path.join(repo, 'src', 'app');
    const problems: string[] = [];
    const expectFocus = async (
      label: string,
      session: McpSession,
      extraArgs: Record<string, unknown>,
      expected: string[],
    ): Promise<void> => {
      const ans = await session.tool(PROBE, { projectPath: repo, ...extraArgs });
      const report = probeOf(ans);
      if (report === null) {
        problems.push(`${label}: the probe was not served: ${excerpt(ans)}`);
        return;
      }
      if (JSON.stringify(report.focus) !== JSON.stringify(expected)) {
        problems.push(`${label}: ctx.focus is ${JSON.stringify(report.focus)}, expected ${JSON.stringify(expected)}`);
      }
      for (const key of ['__cgSessionFocus', '__cgSessionTools']) {
        if (report.argKeys.includes(key)) problems.push(`${label}: the extension received the internal key ${key}`);
      }
    };

    await expectFocus('the focused session', focused, {}, [appDir]);
    await expectFocus('the unfocused session', unfocused, {}, []);
    await expectFocus('the session launched in src/lib with --focus src/app', fromLib, {}, [appDir]);
    await expectFocus('the focused session with a wire __cgSessionFocus naming /etc and src/lib', focused, { __cgSessionFocus: ['/etc', 'src/lib'] }, [appDir]);
    await expectFocus('the unfocused session with a wire __cgSessionFocus naming src/app', unfocused, { __cgSessionFocus: [appDir] }, []);

    expect(problems, 'G5 problems (empty when ctx.focus is the session focus and no wire argument sets it)').toEqual([]);
  }, 150_000);

  // G8: --focus is relative to the repository root and applies to every worktree of the repository. The session
  // is launched in repository A, and the calls name projectPath B, a sibling linked worktree with the same
  // src/app and src/lib: they are held to B's own src/app, not to A's. The focus a launcher gives is one spelling
  // for the whole repository, so a subagent working in its own worktree is filtered exactly as the lead is.
  it('G8: --focus src/app launched in repository A filters calls on sibling worktree B to B/src/app', async () => {
    // Long by design: a CLI index run of A, a serve --mcp cold start, a copied index and catch-up for B (its first
    // call seeds it), and ten tool calls.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    const wt = fx.addWorktree(repo, 'g8-sibling', path.join(root, 'sibling'));
    const env = { CODEGRAPH_EXTENSION_MODULES: FIXTURE, CODEGRAPH_MCP_TOOLS: `${TOOLS},${PROBE_SHORT}` };
    const session = fx.session({ cwd: repo, stateDir, args: ['--focus', 'src/app'], env });
    await session.initialize();

    const problems: string[] = [];
    // B has no index of its own: its first call seeds one from A's. Call (scope "repo", so no focus decides the
    // result) until B answers from its own index, then judge the focused calls.
    const deadline = Date.now() + 120_000;
    let warm: ToolAnswer | undefined;
    while (Date.now() < deadline) {
      warm = await session.tool(SEARCH, { query: 'appFocusFn', scope: 'repo', projectPath: wt });
      if (!warm.isError && warm.text.includes('src/app/app.ts')) break;
      await sleep(500);
    }
    if (warm === undefined || warm.isError || !warm.text.includes('src/app/app.ts')) {
      problems.push(`the sibling worktree never answered from its own index within 120 s: ${warm === undefined ? 'no answer' : excerpt(warm)}`);
    }

    const inApp = await session.tool(SEARCH, { query: 'appFocusFn', projectPath: wt });
    if (inApp.isError || !inApp.text.includes('src/app/app.ts')) {
      problems.push(`B: search for an in-focus symbol did not return src/app/app.ts: ${excerpt(inApp)}`);
    }
    const outSearch = await session.tool(SEARCH, { query: 'outsideCaller', projectPath: wt });
    if (outSearch.isError || outSearch.rpcError !== null) {
      problems.push(`B: search for an out-of-focus symbol was an error, not a success-shaped answer: ${excerpt(outSearch)}`);
    }
    if (outSearch.text.includes('src/lib/')) {
      problems.push(`B: search in focus returned a src/lib result: ${excerpt(outSearch)}`);
    }
    const inExplore = await session.tool(EXPLORE, { query: 'appFocusFn', projectPath: wt });
    if (!answers(inExplore, 'appFocusFn', APP_MARKER)) {
      problems.push(`B: explore for an in-focus symbol did not return its source: ${excerpt(inExplore)}`);
    }
    if (inExplore.text.includes('src/lib/') || inExplore.text.includes(LIB_MARKER)) {
      problems.push(`B: explore in focus showed a src/lib item: ${excerpt(inExplore)}`);
    }
    const outExplore = await session.tool(EXPLORE, { query: 'outsideCaller', projectPath: wt });
    if (outExplore.isError || outExplore.rpcError !== null) {
      problems.push(`B: explore for an out-of-focus symbol was an error, not a success-shaped answer: ${excerpt(outExplore)}`);
    }
    if (outExplore.text.includes(OUT_CALLER_MARKER) || outExplore.text.includes('src/lib/')) {
      problems.push(`B: explore in focus returned src/lib for an out-of-focus symbol: ${excerpt(outExplore)}`);
    }

    for (const tool of [CALLERS, IMPACT]) {
      const label = `B: ${tool.replace('codegraph_', '')}`;
      const ans = await session.tool(tool, { symbol: 'focusTarget', projectPath: wt });
      const at = ans.text.indexOf(OUTSIDE_HEADING);
      if (ans.isError || at === -1) {
        problems.push(`${label} has no "${OUTSIDE_HEADING}" heading: ${excerpt(ans)}`);
        continue;
      }
      const inPart = ans.text.slice(0, at);
      const outPart = ans.text.slice(at);
      if (!inPart.includes('inFocusCaller')) problems.push(`${label} does not list inFocusCaller in the in-focus part: ${excerpt(ans)}`);
      if (inPart.includes('outsideCaller')) problems.push(`${label} lists outsideCaller in the in-focus part`);
      if (!outPart.includes('outsideCaller')) problems.push(`${label} does not list outsideCaller under the Outside focus heading`);
    }

    // The extension's context carries the focus resolved for B: B's own src/app.
    const probe = probeOf(await session.tool(PROBE, { projectPath: wt }));
    const expected = [path.join(wt, 'src', 'app')];
    if (probe === null) {
      problems.push('B: the probe was not served');
    } else if (JSON.stringify(probe.focus) !== JSON.stringify(expected)) {
      problems.push(`B: ctx.focus is ${JSON.stringify(probe.focus)}, expected ${JSON.stringify(expected)}`);
    }

    expect(problems, 'G8 problems (empty when a sibling worktree is held to its own src/app)').toEqual([]);
  }, 300_000);
});

describe('a --focus symlink that leaves the repository', () => {
  const fx = new Fixtures();
  afterEach(() => fx.teardown(), 60_000);

  // G7: a symlink `up` in the repository to an ancestor of it, launched with `--focus up --focus src/app`. The `up`
  // entry canonicalises to that ancestor, which contains every index root and would switch filtering off for the
  // whole session. It is dropped, so the session filters by src/app alone. The target is the fixture's temp root
  // rather than `/` (the unit test uses `/`): the index sync follows a symlink to a directory outside the
  // repository, and a sync of `/` walks the whole disk.
  it.runIf(process.platform !== 'win32')('G7: --focus up --focus src/app (up -> an ancestor of the repository) still keeps search inside src/app', async () => {
    // Long by design: a CLI index run of the repository, a serve --mcp cold start
    // (each node process loads the wasm runtime), and three searches.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = focusRepo(fx, root, stateDir);
    // The symlink is made after the index run; the session's first call syncs it in.
    fs.symlinkSync(root, path.join(repo, 'up'), 'dir');
    const session = fx.session({
      cwd: repo,
      stateDir,
      args: ['--focus', 'up', '--focus', 'src/app'],
      env: { CODEGRAPH_MCP_TOOLS: TOOLS },
    });
    await session.initialize();

    const problems: string[] = [];
    const inApp = await session.tool(SEARCH, { query: 'appFocusFn', projectPath: repo });
    if (inApp.isError || !inApp.text.includes('src/app/app.ts')) {
      problems.push(`search for an in-focus symbol did not return src/app/app.ts: ${excerpt(inApp)}`);
    }
    const outSearch = await session.tool(SEARCH, { query: 'outsideCaller', projectPath: repo });
    if (outSearch.isError || outSearch.rpcError !== null) {
      problems.push(`search for an out-of-focus symbol was an error: ${excerpt(outSearch)}`);
    }
    if (outSearch.text.includes('src/lib/')) {
      problems.push(`search returned a src/lib result although src/app is the only in-repository focus: ${excerpt(outSearch)}`);
    }
    const outExplore = await session.tool(EXPLORE, { query: 'outsideCaller', projectPath: repo });
    if (outExplore.text.includes(OUT_CALLER_MARKER) || outExplore.text.includes('src/lib/')) {
      problems.push(`explore returned src/lib for an out-of-focus symbol: ${excerpt(outExplore)}`);
    }

    expect(problems, 'G7 problems (empty when the escaping symlink entry is dropped and src/app still filters)').toEqual([]);
  }, 150_000);
});

describe('serve --mcp --focus refuses a focus outside the repository (no server starts)', () => {
  const fx = new Fixtures();
  afterEach(() => fx.teardown(), 60_000);

  // G6: an absolute --focus, or one that escapes the repository after normalisation, is refused with the bad value
  // named on stderr and exit status 1, before any server starts.
  it.each(['/etc', '../outside', 'src/../../outside'])('refuses --focus %s with a message that names it', async (bad) => {
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/app/app.ts': 'export const app = 1;\n' });
    const run = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--focus', bad], {
      cwd: repo,
      env: gateEnv(stateDir),
      input: '',
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    const started = serverPidOf(stateDir);
    if (started !== null) await stopIfCodegraph(started);

    expect(run.status, `exit status for --focus ${bad}`).toBe(1);
    expect(run.stderr, `stderr for --focus ${bad} names the bad value`).toContain(bad);
    expect(started, `no server started for --focus ${bad}`).toBeNull();
  }, 60_000);
});
