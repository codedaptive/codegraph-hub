/**
 * Focus-scope gates: `serve --mcp --focus src/app` over stdio, as an agent host runs it, on two throwaway
 * repositories. Each describe block builds and indexes its repository once, in beforeAll.
 *
 * Under a non-empty session focus, an explore call takes the focus into three places:
 * - the Flow strip is the deepest call chain whose every step is inside the focus; a chain that passes through a
 *   file outside the focus is not chosen;
 * - the empty-result explanation's matched words and candidates are read from in-focus code only;
 * - the explanation's "Checked ..." line names the focus and says how to widen the check (scope "repo").
 * With no focus, or with scope "repo", the answer is the unfocused one.
 *
 * Flow strip under a focus (describe 1; the fixture is defect1Files below, src/app and src/lib):
 * - S1: a focused explore for 'entry stepOne stepTwo tailMid tailEnd' shows the Flow strip entry -> stepOne -> stepTwo,
 *   and no src/lib file and no libHop step.
 * - S2: a focused explore for 'startOrder libBridge finishOrder' shows no Flow step naming libBridge, and no src/lib
 *   file. No chain inside src/app joins these names; the gate does not assert a Flow strip either way.
 * - S5: an unfocused explore and a focused explore with scope "repo" for the S1 query give the same text, and the
 *   Flow strip runs entry -> libHop -> tailMid -> tailEnd.
 *
 * Empty-result explanation under a focus (describe 2; the fixture is defect2Files below, src/app and src/lib):
 * - S3: a focused explore for 'b c' answers "No relevant code found", names neither billingLedgerSync nor
 *   cacheVaultKey (both only in src/lib), lists no matched word that only out-of-focus code matches, and carries the
 *   focused "Checked ..." line.
 * - S4: an unfocused explore and a focused explore with scope "repo" for 'b c' give the same text, which names
 *   billingLedgerSync and does not carry the focused "Checked ..." line.
 *
 * The helpers are in `machine-server.harness.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { Fixtures, McpSession, NO_RESULT_PHRASE, ToolAnswer, excerpt } from './machine-server.harness';

const EXPLORE = 'codegraph_explore';
/** The built-in tools a focus session allows. The same list the other focus gates use. */
const TOOLS = 'explore,search,callers,impact,node,callees,files,status';
const FOCUS = ['--focus', 'src/app'];
const LIB_DIR = 'src/lib/';
/** The heading explore prints above the Flow strip. */
const FLOW_HEADING = '**Flow (';
const ENTRY_QUERY = 'entry stepOne stepTwo tailMid tailEnd';
const START_QUERY = 'startOrder libBridge finishOrder';
/** The chain the focused entry query must show: the deepest one whose every step is in src/app. */
const FOCUSED_CHAIN = ['entry', 'stepOne', 'stepTwo'];
/** The chain the unfocused entry query shows: the deepest one, through src/lib. */
const UNFOCUSED_CHAIN = ['entry', 'libHop', 'tailMid', 'tailEnd'];
/**
 * The explanation line an empty answer prints when the focus has a directory in this index: the focus named, and how
 * to widen the check.
 */
const CHECKED_FOCUSED =
  "Checked indexed names, signatures, docstrings (FTS prefixes) and live name segments inside this session's focus (src/app); not all source text. Pass scope: \"repo\" to check the whole repository.";
/** The explanation line an empty answer prints with no focus, or with scope "repo". */
const CHECKED_PLAIN = 'Checked indexed names, signatures, docstrings (FTS prefixes) and live name segments; not all source text.';
/** Names defined only in src/lib: an empty answer for 'b c' must not show them. */
const LIB_ONLY_NAMES = ['billingLedgerSync', 'cacheVaultKey'];

/**
 * The fixture of describe 1. src/app holds entry -> stepOne -> stepTwo, and entry -> libHop (src/lib) -> tailMid ->
 * tailEnd, so the unfocused deepest chain goes through src/lib. startOrder -> libBridge (src/lib) -> finishOrder joins
 * two in-focus names only through src/lib.
 */
function defect1Files(): Record<string, string> {
  return {
    'src/app/app.ts':
      "import { libBridge, libHop } from '../lib/lib';\n" +
      'export function startOrder(): string { return libBridge(); }\n' +
      'export function finishOrder(): string { return "done"; }\n' +
      'export function stepTwo(): string { return "two"; }\n' +
      'export function stepOne(): string { return stepTwo(); }\n' +
      'export function tailEnd(): string { return "end"; }\n' +
      'export function tailMid(): string { return tailEnd(); }\n' +
      'export function entry(): string { stepOne(); return libHop(); }\n',
    'src/lib/lib.ts':
      "import { finishOrder, tailMid } from '../app/app';\n" +
      'export function libBridge(): string { return finishOrder(); }\n' +
      'export function libHop(): string { return tailMid(); }\n',
  };
}

/**
 * The fixture of describe 2. The focus holds one symbol with no word starting 'b' or 'c'. src/lib holds the names and
 * the docstring word ("backlog") that the query 'b c' matches.
 */
function defect2Files(): Record<string, string> {
  return {
    'src/app/app.ts': 'export function renderPane(): string { return "pane"; }\n',
    'src/lib/secret.ts':
      '/** Reconciles the frobnicate backlog. */\n' +
      'export function billingLedgerSync(): string { return "x"; }\n' +
      'export function cacheVaultKey(): string { return "y"; }\n',
  };
}

/** The lines of an answer's Flow strip: from its heading to the line that opens the source part (">") or the next heading. */
function flowLines(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith(FLOW_HEADING));
  if (at === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('>') || line.startsWith('**')) break;
    body.push(line);
  }
  return body;
}

/** The symbol names of a Flow strip's numbered steps, in order: "2. stepOne (src/app/app.ts:5)" gives "stepOne". */
function flowSteps(text: string): string[] {
  const names: string[] = [];
  for (const line of flowLines(text)) {
    const m = /^\d+\. (\S+) \(/.exec(line);
    if (m?.[1] !== undefined) names.push(m[1]);
  }
  return names;
}

/** True when the call answered without an error flag and without a JSON-RPC error. */
function succeeded(ans: ToolAnswer): boolean {
  return !ans.isError && ans.rpcError === null;
}

describe('focus scope gates: the Flow strip under a focus (serve --mcp --focus over stdio, one throwaway repository)', () => {
  const shared = new Fixtures();
  let repo = '';
  let stateDir = '';

  beforeAll(() => {
    // One CLI index run over this describe block's files, shared by every gate here so each starts from the same index.
    const root = shared.tempRoot();
    stateDir = path.join(root, 'state');
    repo = shared.makeRepo(path.join(root, 'repo'), defect1Files());
    shared.index(repo, stateDir);
  }, 180_000);

  afterAll(() => shared.teardown(), 60_000);

  /** One initialized serve --mcp session on the repository, for `run`. The session ends when `run` returns. */
  async function inSession<T>(args: string[], run: (session: McpSession) => Promise<T>): Promise<T> {
    const session = shared.session({ cwd: repo, stateDir, args, env: { CODEGRAPH_MCP_TOOLS: TOOLS } });
    try {
      await session.initialize();
      return await run(session);
    } finally {
      await session.end();
    }
  }

  /** One explore call on the repository, as an agent makes it. The first call of a session reads the index cold. */
  function explore(session: McpSession, query: string, extra: Record<string, unknown> = {}): Promise<ToolAnswer> {
    return session.tool(EXPLORE, { query, projectPath: repo, ...extra }, 120_000);
  }

  // Reason for the long timeout: one serve --mcp cold start (a node process that loads the wasm runtime) and one
  // explore call that reads the index cold.
  it('S1: --focus src/app: the Flow strip for entry stepOne stepTwo tailMid tailEnd is entry -> stepOne -> stepTwo', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, ENTRY_QUERY));

    const problems: string[] = [];
    if (!succeeded(ans)) problems.push(`the answer was an error: ${excerpt(ans)}`);
    if (flowLines(ans.text).length === 0) {
      problems.push(`the answer has no Flow strip, so the chain inside the focus is not shown: ${excerpt(ans)}`);
    } else if (JSON.stringify(flowSteps(ans.text)) !== JSON.stringify(FOCUSED_CHAIN)) {
      problems.push(
        `the Flow strip is ${JSON.stringify(flowSteps(ans.text))}, expected ${JSON.stringify(FOCUSED_CHAIN)}: ${JSON.stringify(flowLines(ans.text))}`,
      );
    }
    if (flowLines(ans.text).some((line) => line.includes('libHop'))) {
      problems.push(`the Flow strip goes through libHop: ${JSON.stringify(flowLines(ans.text))}`);
    }
    if (ans.text.includes(LIB_DIR)) problems.push(`explore in focus named a src/lib file: ${excerpt(ans)}`);
    expect(problems, 'S1 problems (empty when the Flow strip is entry -> stepOne -> stepTwo, with no libHop step and no src/lib file)')
      .toEqual([]);
  }, 150_000);

  // Reason for the long timeout: one serve --mcp cold start and one explore call that reads the index cold.
  it('S2: --focus src/app: startOrder libBridge finishOrder shows no Flow step naming libBridge, and no src/lib file', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, START_QUERY));

    const problems: string[] = [];
    if (!succeeded(ans)) problems.push(`the answer was an error: ${excerpt(ans)}`);
    if (flowLines(ans.text).some((line) => line.includes('libBridge'))) {
      problems.push(`the Flow strip names libBridge, which only src/lib defines: ${JSON.stringify(flowLines(ans.text))}`);
    }
    if (ans.text.includes(LIB_DIR)) problems.push(`explore in focus named a src/lib file: ${excerpt(ans)}`);
    expect(problems, 'S2 problems (empty when no Flow step names libBridge and no src/lib file shows)').toEqual([]);
  }, 150_000);

  // Reason for the long timeout: two serve --mcp cold starts (one unfocused, one focused) and two explore calls that
  // read the index cold.
  it('S5: no focus and focus + scope "repo" give the same entry answer, whose Flow strip runs entry -> libHop -> tailMid -> tailEnd', async () => {
    const plain = await inSession([], (session) => explore(session, ENTRY_QUERY));
    const wide = await inSession(FOCUS, (session) => explore(session, ENTRY_QUERY, { scope: 'repo' }));

    const problems: string[] = [];
    if (!succeeded(plain)) problems.push(`the unfocused answer was an error: ${excerpt(plain)}`);
    if (!succeeded(wide)) problems.push(`the scope-repo answer was an error: ${excerpt(wide)}`);
    if (JSON.stringify(flowSteps(plain.text)) !== JSON.stringify(UNFOCUSED_CHAIN)) {
      problems.push(`the unfocused Flow strip is ${JSON.stringify(flowSteps(plain.text))}, expected ${JSON.stringify(UNFOCUSED_CHAIN)}`);
    }
    if (JSON.stringify(flowSteps(wide.text)) !== JSON.stringify(UNFOCUSED_CHAIN)) {
      problems.push(`the scope-repo Flow strip is ${JSON.stringify(flowSteps(wide.text))}, expected ${JSON.stringify(UNFOCUSED_CHAIN)}`);
    }
    expect(problems, 'S5 problems (empty when both answers succeed and their Flow strips run through libHop)').toEqual([]);
    expect(wide.text, 'S5: the focus + scope "repo" text equals the unfocused text, byte for byte').toEqual(plain.text);
  }, 240_000);
});

describe('focus scope gates: the empty-result explanation under a focus (serve --mcp --focus over stdio, one throwaway repository)', () => {
  const shared = new Fixtures();
  let repo = '';
  let stateDir = '';

  beforeAll(() => {
    // One CLI index run over this describe block's files, shared by every gate here so each starts from the same index.
    const root = shared.tempRoot();
    stateDir = path.join(root, 'state');
    repo = shared.makeRepo(path.join(root, 'repo'), defect2Files());
    shared.index(repo, stateDir);
  }, 180_000);

  afterAll(() => shared.teardown(), 60_000);

  /** One initialized serve --mcp session on the repository, for `run`. The session ends when `run` returns. */
  async function inSession<T>(args: string[], run: (session: McpSession) => Promise<T>): Promise<T> {
    const session = shared.session({ cwd: repo, stateDir, args, env: { CODEGRAPH_MCP_TOOLS: TOOLS } });
    try {
      await session.initialize();
      return await run(session);
    } finally {
      await session.end();
    }
  }

  /** One explore call on the repository, as an agent makes it. The first call of a session reads the index cold. */
  function explore(session: McpSession, query: string, extra: Record<string, unknown> = {}): Promise<ToolAnswer> {
    return session.tool(EXPLORE, { query, projectPath: repo, ...extra }, 120_000);
  }

  // Reason for the long timeout: one serve --mcp cold start (a node process that loads the wasm runtime) and one
  // explore call that reads the index cold.
  it('S3: --focus src/app, query "b c": the empty answer names no src/lib symbol and carries the focused explanation line', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, 'b c'));

    const problems: string[] = [];
    if (!succeeded(ans)) problems.push(`the answer was an error, not the empty-result answer: ${excerpt(ans)}`);
    if (!ans.text.startsWith(NO_RESULT_PHRASE)) {
      problems.push(`the answer does not start with "${NO_RESULT_PHRASE}": ${excerpt(ans)}`);
    }
    for (const name of LIB_ONLY_NAMES) {
      if (ans.text.includes(name)) problems.push(`the empty answer names ${name}, which only src/lib defines: ${excerpt(ans)}`);
    }
    const lines = ans.text.split('\n');
    if (!lines.includes(CHECKED_FOCUSED)) {
      problems.push(`no focused explanation line; the Checked lines are ${JSON.stringify(lines.filter((l) => l.startsWith('Checked')))}`);
    }
    if (lines.includes(CHECKED_PLAIN)) problems.push('the unfocused explanation line shows inside the focus');
    // 'b' and 'c' match only src/lib names and the docstring word "backlog", so neither may be a matched word in focus.
    for (const line of lines.filter((l) => l.startsWith('Matched indexed words:'))) {
      for (const word of ['`b`', '`c`']) {
        if (line.includes(word)) problems.push(`the matched words name ${word}, which only out-of-focus code matches: ${JSON.stringify(line)}`);
      }
    }
    expect(problems, 'S3 problems (empty when the answer is the empty-result answer with the focused explanation and no src/lib name)')
      .toEqual([]);
  }, 150_000);

  // Reason for the long timeout: two serve --mcp cold starts (one unfocused, one focused) and two explore calls that
  // read the index cold.
  it('S4: "b c" with no focus and with focus + scope "repo" gives the same text, which names billingLedgerSync', async () => {
    const plain = await inSession([], (session) => explore(session, 'b c'));
    const wide = await inSession(FOCUS, (session) => explore(session, 'b c', { scope: 'repo' }));

    const problems: string[] = [];
    if (!succeeded(plain) || !plain.text.startsWith(NO_RESULT_PHRASE) || !plain.text.includes('billingLedgerSync')) {
      problems.push(`the unfocused answer is not the empty-result answer naming billingLedgerSync, so the comparison proves nothing: ${excerpt(plain)}`);
    }
    if (plain.text.split('\n').includes(CHECKED_FOCUSED)) problems.push('the unfocused answer carries the focused explanation line');
    if (!succeeded(wide)) problems.push(`the scope-repo answer was an error: ${excerpt(wide)}`);
    if (!wide.text.includes('billingLedgerSync')) problems.push(`the scope-repo answer does not name billingLedgerSync: ${excerpt(wide)}`);
    if (wide.text.split('\n').includes(CHECKED_FOCUSED)) problems.push('the scope-repo answer carries the focused explanation line');
    expect(problems, 'S4 problems (empty when both answers are the empty-result answer naming billingLedgerSync, with no focus line)')
      .toEqual([]);
    expect(wide.text, 'S4: the focus + scope "repo" text equals the unfocused text, byte for byte').toEqual(plain.text);
  }, 240_000);
});
