/**
 * Focus-recall gates: `serve --mcp --focus src/app` over stdio, as an agent host runs it, on one throwaway
 * repository. src/app holds one symbol, `renderWidgetPanel`. src/lib holds 60 files, each with `buildWidgetNN` and
 * `widgetHelperNN`. Every query here is about `widget`, which matches far more out-of-focus symbols than the
 * explore recall returns.
 *
 * The recall is given the session focus (`pathPrefixes`), so its top hits are drawn from the focus. A recall over
 * the whole index fills its limit with src/lib symbols; the focus cut that follows then leaves nothing, and the
 * session is told nothing is in focus. G1 checks that the in-focus symbol comes back, G2 that a query matching
 * only out-of-focus code gets the nothing-in-focus sentence, and G3 that scope "repo" gives the unfocused answer.
 * - G1: explore for 'widget' with --focus src/app returns renderWidgetPanel's source and no src/lib file.
 * - G2: explore for 'buildWidget01', a symbol that only src/lib holds, answers the nothing-in-focus sentence. The
 *   sentence names the focus and scope "repo", and names no src/lib file.
 * - G3: an unfocused session and a --focus src/app session that searches with scope "repo" give the same explore
 *   text for the same queries, and that text names buildWidget.
 *
 * The helpers are in `machine-server.harness.ts`. The index is built once for the whole file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { Fixtures, McpSession, ToolAnswer, answers, excerpt } from './machine-server.harness';

const EXPLORE = 'codegraph_explore';
/** The built-in tools a focus session allows. The same list the session-focus gates use. */
const TOOLS = 'explore,search,callers,impact,node,callees,files,status';
const FOCUS = ['--focus', 'src/app'];
const PANEL_BODY = 'focus-recall-panel-body-marker';
const NOTHING_IN_FOCUS = "No results inside this session's focus (src/app)";
const WIDEN = 'scope: "repo"';
const LIB_DIR = 'src/lib/';
const LIB_FILES = 60;

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

describe('focus recall gates (serve --mcp --focus over stdio, one throwaway repository)', () => {
  // Time goes to a serve --mcp cold start (each node process loads the wasm runtime) and one explore call that
  // reads the index cold.
  it('G1: --focus src/app: explore for widget returns renderWidgetPanel, and no src/lib file', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, 'widget'));

    const problems: string[] = [];
    if (!answers(ans, 'renderWidgetPanel', PANEL_BODY)) {
      problems.push(`explore for 'widget' in focus did not return renderWidgetPanel's source: ${excerpt(ans)}`);
    }
    if (ans.text.includes(LIB_DIR)) problems.push(`explore in focus named a src/lib file: ${excerpt(ans)}`);
    expect(problems, 'G1 problems (empty when the in-focus symbol is recalled and no src/lib file is shown)').toEqual([]);
  }, 150_000);

  it('G2: --focus src/app: explore for a symbol only src/lib holds answers the nothing-in-focus sentence', async () => {
    const ans = await inSession(FOCUS, (session) => explore(session, 'buildWidget01'));

    const problems: string[] = [];
    if (ans.isError || ans.rpcError !== null) {
      problems.push(`the answer was an error, not a success-shaped sentence: ${excerpt(ans)}`);
    }
    if (!ans.text.includes(NOTHING_IN_FOCUS)) problems.push(`the answer does not name the focus: ${excerpt(ans)}`);
    if (!ans.text.includes(WIDEN)) problems.push(`the answer does not say how to widen the call: ${excerpt(ans)}`);
    if (ans.text.includes(LIB_DIR)) problems.push(`the answer names a src/lib file: ${excerpt(ans)}`);
    expect(problems, 'G2 problems (empty when the answer is the nothing-in-focus sentence with no src/lib file)').toEqual([]);
  }, 150_000);

  // The two sessions run one after the other, since each needs its own --focus. Each runs the same two queries in
  // the same order, so the second query sees the same explore history (what the session already served) in both.
  // Time goes to two serve --mcp cold starts and four explore calls.
  it('G3: an unfocused session and a --focus src/app session with scope "repo" give the same explore text', async () => {
    const queries = ['widget', 'buildWidget01'];

    const plain: ToolAnswer[] = [];
    await inSession([], async (session) => {
      for (const query of queries) plain.push(await explore(session, query));
    });

    const wide: ToolAnswer[] = [];
    await inSession(FOCUS, async (session) => {
      for (const query of queries) wide.push(await explore(session, query, { scope: 'repo' }));
    });

    const problems: string[] = [];
    queries.forEach((query, i) => {
      const a = plain[i];
      const b = wide[i];
      if (a === undefined || b === undefined) {
        problems.push(`no answer for '${query}' in one of the sessions`);
        return;
      }
      if (a.isError || a.rpcError !== null || !a.text.includes('buildWidget')) {
        problems.push(`unfocused explore for '${query}' does not name buildWidget: ${excerpt(a)}`);
      }
      if (b.isError || b.rpcError !== null || !b.text.includes('buildWidget')) {
        problems.push(`focused explore with scope "repo" for '${query}' does not name buildWidget: ${excerpt(b)}`);
      }
    });
    expect(problems, 'G3 problems (empty when both sessions answer with buildWidget)').toEqual([]);
    expect(wide.map((ans) => ans.text), 'G3: the focused scope-repo texts equal the unfocused texts, query by query')
      .toEqual(plain.map((ans) => ans.text));
  }, 150_000);
});
