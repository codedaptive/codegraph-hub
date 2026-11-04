/**
 * Focus-note ceiling gates: `serve --mcp --focus src/app` over stdio, as an agent host runs it, on a throwaway
 * repository with the focus-note layout (the same as focus-note.gate.test.ts). src/app holds one symbol,
 * `renderWidgetPanel`. src/lib holds 60 files, each with `buildWidgetNN` and `widgetHelperNN`.
 *
 * These gates pin what must NOT change below the hard ceiling. The ceiling cut itself is unit-tested in
 * focus-note-ceiling.unit.test.ts. Stdio cannot reach that cut: the answers read here are far below the ceiling of
 * 19,500 characters, so these answers show the focus line and the unfocused text as they are rendered below the
 * ceiling.
 *
 * - K1: an unfocused explore for widgetHelper07 returns widget07.ts's source and no focus line. It is the reference
 *   for K2.
 * - K2: a focused explore with scope "repo" for widgetHelper07 equals the unfocused text, byte for byte.
 * - K3: a focused explore for widgetHelper07 keeps renderWidgetPanel's source and ends with exactly one focus line,
 *   for widgetHelper07, after one blank line. No src/lib path is named.
 * - K4: a focused explore for 'renderWidgetPanel widgetHelper01 widgetHelper02 widgetHelper03 widgetHelper04' keeps
 *   renderWidgetPanel's source and ends with exactly three focus lines, for widgetHelper01, 02 and 03 in that order.
 *   The cap of three holds, so widgetHelper04 gets none.
 * - K5: a focused explore for renderWidgetPanel, defined in the focus, gets no focus line.
 *
 * A focus line is the whole sentence (see focus-note.gate.test.ts): the summary note a focus cut writes shares a
 * phrase with it, and that note is not a focus line.
 *
 * Every session here is fresh and asks one query, so the explore history a session has served cannot change the
 * text. The helpers are in `machine-server.harness.ts`. The index is built once for the whole file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { Fixtures, McpSession, ToolAnswer, answers, excerpt } from './machine-server.harness';

const EXPLORE = 'codegraph_explore';
/** The built-in tools a focus session allows. The same list the session-focus gates use. */
const TOOLS = 'explore,search,callers,impact,node,callees,files,status';
const FOCUS = ['--focus', 'src/app'];
const PANEL_BODY = 'focus-recall-panel-body-marker';
const LIB_DIR = 'src/lib/';
const WIDGET_FILE = 'src/lib/widget07.ts';
/** The source line of widgetHelper07 in its file, as the unfocused answer shows it. */
const WIDGET_SOURCE = 'export function widgetHelper07';
const LIB_FILES = 60;
/** The words every focus line shares after its name. A line is a focus line when it carries this sentence. */
const FOCUS_SENTENCE_MARK = "is defined in this index, outside this session's focus";

/** The repository's files: one in-focus symbol in src/app, and LIB_FILES out-of-focus files in src/lib. */
function widgetFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'src/app/panel.ts': `export function renderWidgetPanel(): string { return "${PANEL_BODY}"; }\n`,
  };
  for (let i = 0; i < LIB_FILES; i++) {
    const nn = String(i).padStart(2, '0');
    files[`src/lib/widget${nn}.ts`] =
      `export function buildWidget${nn}(): string { return "widget"; }\n` +
      `export function widgetHelper${nn}(): string { return buildWidget${nn}(); }\n`;
  }
  return files;
}

/** The focus line for `name`: the name in backticks, then the sentence, on one line. */
function focusLine(name: string): string {
  return `\`${name}\` is defined in this index, outside this session's focus; pass scope: "repo" to include it.`;
}

/** The lines of an answer that carry the focus sentence, whatever the name. */
function focusLines(text: string): string[] {
  return text.split('\n').filter((line) => line.includes(FOCUS_SENTENCE_MARK));
}

/** The end of an answer, for a failure message. */
function tailOf(ans: ToolAnswer): string {
  return JSON.stringify(ans.text.trimEnd().slice(-240));
}

/** True when the call answered without an error flag and without a JSON-RPC error. */
function succeeded(ans: ToolAnswer): boolean {
  return !ans.isError && ans.rpcError === null;
}

const shared = new Fixtures();
let repo = '';
let stateDir = '';

beforeAll(() => {
  // One CLI index run over the 61 files, shared by every gate so each starts from the same index.
  const root = shared.tempRoot();
  stateDir = path.join(root, 'state');
  repo = shared.makeRepo(path.join(root, 'repo'), widgetFiles());
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

describe('focus note ceiling gates (serve --mcp --focus over stdio, one throwaway repository)', () => {
  // Reason for the long timeout: one serve --mcp cold start (a node process that loads the wasm runtime) and one
  // explore call that reads the index cold.
  it('K1: no focus: explore for widgetHelper07 returns widget07.ts source and no focus line', async () => {
    const ans = await inSession([], (session) => explore(session, 'widgetHelper07'));

    const problems: string[] = [];
    if (!succeeded(ans) || !ans.text.includes(WIDGET_FILE) || !ans.text.includes(WIDGET_SOURCE)) {
      problems.push(`the unfocused answer does not return ${WIDGET_FILE}'s source, so the reference for K2 proves nothing: ${excerpt(ans)}`);
    }
    if (focusLines(ans.text).length > 0) {
      problems.push(`an unfocused answer got a focus line: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'K1 problems (empty when the unfocused answer returns widget07.ts source and has no focus line)').toEqual([]);
  }, 150_000);

  // Reason for the long timeout: two serve --mcp cold starts (one focused, one unfocused) and two explore calls
  // that read the index cold.
  it('K2: focus with scope "repo": explore for widgetHelper07 equals the unfocused text, byte for byte', async () => {
    const wide = await inSession(FOCUS, (session) => explore(session, 'widgetHelper07', { scope: 'repo' }));
    const plain = await inSession([], (session) => explore(session, 'widgetHelper07'));

    const problems: string[] = [];
    if (!succeeded(wide)) problems.push(`the scope-repo answer was an error: ${excerpt(wide)}`);
    // The comparison below is only meaningful when the unfocused answer is the real one.
    if (!succeeded(plain) || !plain.text.includes(WIDGET_FILE)) {
      problems.push(`the unfocused answer does not name ${WIDGET_FILE}, so the comparison proves nothing: ${excerpt(plain)}`);
    }
    if (focusLines(wide.text).length > 0) {
      problems.push(`a scope-repo answer got a focus line: ${JSON.stringify(focusLines(wide.text))}`);
    }
    expect(problems, 'K2 problems (empty when the scope-repo answer is a success with no focus line)').toEqual([]);
    expect(wide.text, 'K2: the scope-repo text equals the unfocused text, byte for byte').toEqual(plain.text);
  }, 240_000);

  // Reason for the long timeout: one serve --mcp cold start and one explore call that reads the index cold.
  it('K3: focus: explore for widgetHelper07 keeps renderWidgetPanel and ends with exactly the widgetHelper07 focus line', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, 'widgetHelper07'));

    const problems: string[] = [];
    if (!answers(ans, 'renderWidgetPanel', PANEL_BODY)) {
      problems.push(`explore for 'widgetHelper07' in focus did not keep renderWidgetPanel's source: ${excerpt(ans)}`);
    }
    if (ans.text.includes(LIB_DIR)) problems.push(`explore in focus named a src/lib file: ${excerpt(ans)}`);
    const line = focusLine('widgetHelper07');
    const trimmed = ans.text.trimEnd();
    // One blank line separates the block from the answer: the line follows exactly "\n\n", not "\n" and not "\n\n\n".
    if (!trimmed.endsWith(`\n\n${line}`) || trimmed.endsWith(`\n\n\n${line}`)) {
      problems.push(`the answer does not end with the widgetHelper07 line, after one blank line; it ends ${tailOf(ans)}`);
    }
    if (focusLines(ans.text).length !== 1) {
      problems.push(`expected one focus line, found ${focusLines(ans.text).length}: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'K3 problems (empty when renderWidgetPanel is kept and the answer ends with the widgetHelper07 line)')
      .toEqual([]);
  }, 150_000);

  // Reason for the long timeout: one serve --mcp cold start and one explore call that reads the index cold.
  it('K4: focus: a four-name query ends with exactly three focus lines, for widgetHelper01, 02 and 03 in order', async () => {
    const query = 'renderWidgetPanel widgetHelper01 widgetHelper02 widgetHelper03 widgetHelper04';
    const ans = await inSession(FOCUS, (session) => explore(session, query));

    const problems: string[] = [];
    if (!answers(ans, 'renderWidgetPanel', PANEL_BODY)) {
      problems.push(`explore in focus did not keep renderWidgetPanel's source: ${excerpt(ans)}`);
    }
    const expectedTail = [focusLine('widgetHelper01'), focusLine('widgetHelper02'), focusLine('widgetHelper03')];
    const lines = ans.text.trimEnd().split('\n');
    if (JSON.stringify(lines.slice(-3)) !== JSON.stringify(expectedTail)) {
      problems.push(`the answer does not end with the widgetHelper01, 02 and 03 lines, in order; it ends ${tailOf(ans)}`);
    }
    // One blank line sets the three lines off from the answer above them.
    if (lines[lines.length - 4] !== '') {
      problems.push(`the focus lines are not set off by one blank line; the line before them is ${JSON.stringify(lines[lines.length - 4])}`);
    }
    if (focusLines(ans.text).length !== 3) {
      problems.push(`expected three focus lines, found ${focusLines(ans.text).length}: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'K4 problems (empty when the answer keeps renderWidgetPanel and ends with the 01, 02 and 03 lines only)')
      .toEqual([]);
  }, 150_000);

  // Reason for the long timeout: one serve --mcp cold start and one explore call that reads the index cold.
  it('K5: focus: explore for renderWidgetPanel, defined in the focus, gets no focus line', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, 'renderWidgetPanel'));

    const problems: string[] = [];
    if (!answers(ans, 'renderWidgetPanel', PANEL_BODY)) {
      problems.push(`explore for 'renderWidgetPanel' did not return its source: ${excerpt(ans)}`);
    }
    if (focusLines(ans.text).length > 0) {
      problems.push(`an in-focus name got a focus line: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'K5 problems (empty when the in-focus name is answered and gets no focus line)').toEqual([]);
  }, 150_000);
});
