/**
 * Focus gates for the queries tools, over `serve --mcp --focus src/app` on stdio, as an agent host runs it: grep,
 * blast, orphans and suspects against one throwaway git repository, with CODEGRAPH_STATE_DIR set per test file. The
 * helpers are in `../host/machine-server.harness.ts`; the session-focus gates in `../host` are the pattern.
 *
 * The repository:
 * - src/shared/target.ts defines target(). Its body is edited in the working tree after the index is built (not
 *   committed, line numbers kept), so blast with no base reports what depends on that change.
 * - src/app/app.ts (the focus) has appCaller(), and src/lib/lib.ts (outside it) has libCaller(). Each calls target().
 *   Neither file imports target(): the call binds by name. An import would add a file-level dependent beside each
 *   caller, which blast lists too, so each caller's directory holds exactly one dependent.
 * - "focus-grep-marker" is in both caller files. "lib-only-marker" is only in src/lib/lib.ts.
 * - A second commit adds libUnused() to src/lib/lib.ts, which nothing calls. orphans with base HEAD~1 lists it.
 *
 * Gates:
 * - G1-grep: a focused grep stays inside src/app. scope "repo" brings src/lib back. A pattern found only outside the
 *   focus answers the nothing-in-focus sentence, not an error. A pattern found nowhere answers the zero-hit note. The
 *   json groups are under src/app.
 * - G2-blast: a focused blast covers the whole repository. In text and markdown the outside-focus dependent sits
 *   under "## Outside focus (", after the in-focus one. In json, outsideFocus holds it, and modules does not name it.
 * - G3-orphans-suspects: orphans and suspects answer byte for byte the same in focus as unfocused, and the
 *   out-of-focus items are in both.
 * - G4-no-focus: an unfocused session's grep and blast answers equal the pinned no-focus answers (the handlers' output
 *   with no session focus, the NO_FOCUS_* constants at the end of this file), equal what the handlers return in this
 *   process, and carry no focus wording.
 * - G5-sibling-worktree: a session launched in the anchor repository with --focus src/app, asked about a sibling
 *   worktree of the same repository whose files differ from the anchor's, narrows grep to that worktree's src/app and
 *   puts blast's outside dependent after the heading. The focus is spelled against the repository root, so this gate
 *   checks it holds for a worktree that is not the launch one.
 *
 * Every call passes projectPath. Each gate collects its problems and asserts they are [], so one failure lists every
 * miss.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { blastToolHandler } from '../../../src/extensions/queries/blast/index';
import { handleGrepTool } from '../../../src/extensions/queries/grep/grep-mcp';
import { Fixtures, McpSession, ToolAnswer, sleep } from '../host/machine-server.harness';

const GREP = 'codegraph_grep';
const BLAST = 'codegraph_blast';
const ORPHANS = 'codegraph_orphans';
const SUSPECTS = 'codegraph_suspects';
/** The short names CODEGRAPH_MCP_TOOLS takes for the four tools under test. Every session in this file allows them. */
const SESSION_ENV = { CODEGRAPH_MCP_TOOLS: 'grep,blast,orphans,suspects' };
/** The `--focus` value, relative to the repository root. */
const FOCUS = 'src/app';
/** The sentence a focused grep answers when the focus holds back every hit: host's nothingInFocusText, word for word. */
const NOTHING_IN_FOCUS = `No results inside this session's focus (${FOCUS}). Pass scope: "repo" to search the whole repository.`;
const NOTHING_IN_FOCUS_LEAD = "No results inside this session's focus";
/** The heading the outside-focus part of a blast answer goes under. */
const OUTSIDE_HEADING = '## Outside focus (';
/** In both caller files. */
const SHARED_MARKER = 'focus-grep-marker';
/** Only in src/lib/lib.ts, so a focused grep for it finds nothing inside src/app. */
const LIB_ONLY_MARKER = 'lib-only-marker';
/** In no file of the repository. */
const NOWHERE_MARKER = 'zzz-nowhere-marker';
/** Only in the sibling worktree's committed callers (G5): no file of the launch worktree holds it. */
const SIBLING_ONLY_MARKER = 'sibling-only-marker';
const SIBLING_APP_CALLER = 'siblingAppCaller';
const SIBLING_LIB_CALLER = 'siblingLibCaller';

const TARGET_TS = 'export function target(): string {\n  return "gate-target-body-marker";\n}\n';
/** The uncommitted edit to target()'s body. Same number of lines, so no span in the index moves. */
const TARGET_TS_EDITED = 'export function target(): string {\n  return "gate-target-body-marker-edited";\n}\n';
const APP_TS = 'export function appCaller(): string {\n  return target() + " focus-grep-marker";\n}\n';
const LIB_TS = 'export function libCaller(): string {\n  return target() + " focus-grep-marker lib-only-marker";\n}\n';
/** The second commit: LIB_TS plus a function nothing calls. */
const LIB_TS_WITH_UNUSED = `${LIB_TS}\nexport function libUnused(): string {\n  return "gate-unused-marker";\n}\n`;
/** The sibling's src/app/app.ts and src/lib/lib.ts (G5): APP_TS and LIB_TS plus one caller of target() each. */
const SIBLING_APP_TS = `${APP_TS}\nexport function ${SIBLING_APP_CALLER}(): string {\n  return target() + " ${SIBLING_ONLY_MARKER}";\n}\n`;
const SIBLING_LIB_TS = `${LIB_TS}\nexport function ${SIBLING_LIB_CALLER}(): string {\n  return target() + " ${SIBLING_ONLY_MARKER}";\n}\n`;

/** An answer in full, for a failure message: its text, or its JSON-RPC error, and whether it is a tool error. */
function shown(ans: ToolAnswer): string {
  const body = ans.rpcError ?? ans.text;
  return `${JSON.stringify(body)}${ans.isError ? ' (isError)' : ''}`;
}

/** True for a tool error or a JSON-RPC error. A success-shaped answer, guidance included, is not a failure. */
function failed(ans: ToolAnswer): boolean {
  return ans.isError || ans.rpcError !== null;
}

/** The text of a handler's first content item, as the in-process handlers return the MCP shape. */
function textOf(result: { content: ReadonlyArray<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

/** The parsed JSON object in `text`, or null when it is not one. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The symbol names under `modules[*].symbols`: blast's modules, or outsideFocus.modules. */
function symbolNames(modules: unknown): string[] {
  if (!Array.isArray(modules)) return [];
  const names: string[] = [];
  for (const mod of modules as Array<{ symbols?: unknown } | null>) {
    if (!Array.isArray(mod?.symbols)) continue;
    for (const sym of mod.symbols as Array<{ name?: unknown } | null>) names.push(String(sym?.name));
  }
  return names;
}

/** A grep json group, as far as this file reads it. */
interface GrepJsonGroup {
  path?: unknown;
  symbol?: { path?: unknown } | null;
}

/**
 * The problems with a blast answer in text or markdown under focus: an error, a heading count other than one, `inName`
 * not before the heading, or `outName` not after it. The names default to the fixture's appCaller (in focus) and
 * libCaller (outside it); G5 passes its sibling callers.
 */
function outsideOrderProblems(label: string, ans: ToolAnswer, inName = 'appCaller', outName = 'libCaller'): string[] {
  if (failed(ans)) return [`${label} was an error: ${shown(ans)}`];
  const problems: string[] = [];
  const headings = ans.text.split('\n').filter((line) => line.startsWith(OUTSIDE_HEADING));
  if (headings.length !== 1) problems.push(`${label} has ${headings.length} "${OUTSIDE_HEADING}" lines, expected 1: ${shown(ans)}`);
  const at = ans.text.indexOf(OUTSIDE_HEADING);
  if (at === -1) return [...problems, `${label} has no "${OUTSIDE_HEADING}" heading: ${shown(ans)}`];
  const app = ans.text.indexOf(inName);
  if (app === -1 || app > at) problems.push(`${label} does not list ${inName} before the Outside focus heading: ${shown(ans)}`);
  const lib = ans.text.indexOf(outName);
  if (lib === -1 || lib < at) problems.push(`${label} does not list ${outName} after the Outside focus heading: ${shown(ans)}`);
  return problems;
}

describe('focus gates for grep, blast, orphans and suspects (serve --mcp --focus over stdio, throwaway repository)', () => {
  const fx = new Fixtures();
  let root = '';
  let repo = '';
  let stateDir = '';
  let unfocused: McpSession;
  let focused: McpSession;

  beforeAll(async () => {
    // Setup, not a test: a CLI index run of the repository, then two serve --mcp sessions on one server. The first
    // session starts the server cold (each node process loads the wasm runtime). Every test below shares the sessions.
    root = fx.tempRoot();
    stateDir = path.join(root, 'state');
    repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/shared/target.ts': TARGET_TS,
      'src/app/app.ts': APP_TS,
      'src/lib/lib.ts': LIB_TS,
    });
    fx.commitFiles(repo, { 'src/lib/lib.ts': LIB_TS_WITH_UNUSED }, 'add the uncalled libUnused');
    fx.index(repo, stateDir);
    fs.writeFileSync(path.join(repo, 'src/shared/target.ts'), TARGET_TS_EDITED);
    unfocused = fx.session({ cwd: repo, stateDir, env: SESSION_ENV });
    focused = fx.session({ cwd: repo, stateDir, args: ['--focus', FOCUS], env: SESSION_ENV });
    await unfocused.initialize();
    await focused.initialize();
  }, 240_000);

  afterAll(() => fx.teardown(), 60_000);

  // G1: the focus filters grep. Default answers stay inside src/app. scope "repo" widens them. A pattern found only
  // outside the focus answers the nothing-in-focus sentence, and a pattern found nowhere answers the zero-hit note.
  it('G1-grep: a focused grep stays inside src/app, scope "repo" brings src/lib back, and a pattern found only outside answers the nothing-in-focus sentence', async () => {
    const problems: string[] = [];

    const inFocus = await focused.tool(GREP, { pattern: SHARED_MARKER, projectPath: repo });
    if (failed(inFocus)) problems.push(`grep in focus was an error: ${shown(inFocus)}`);
    if (!inFocus.text.includes('src/app/app.ts')) problems.push(`grep in focus did not return the src/app hit: ${shown(inFocus)}`);
    if (inFocus.text.includes('src/lib/')) problems.push(`grep in focus returned a src/lib hit: ${shown(inFocus)}`);

    const wide = await focused.tool(GREP, { pattern: SHARED_MARKER, scope: 'repo', projectPath: repo });
    if (failed(wide)) problems.push(`grep with scope "repo" was an error: ${shown(wide)}`);
    if (!wide.text.includes('src/app/app.ts') || !wide.text.includes('src/lib/lib.ts')) {
      problems.push(`grep with scope "repo" did not return hits in both src/app and src/lib: ${shown(wide)}`);
    }

    const outside = await focused.tool(GREP, { pattern: LIB_ONLY_MARKER, projectPath: repo });
    if (failed(outside) || outside.text !== NOTHING_IN_FOCUS) {
      problems.push(
        `grep for a pattern found only outside the focus did not answer exactly the nothing-in-focus sentence, and not as an error: ${shown(outside)}`,
      );
    }

    const nowhere = await focused.tool(GREP, { pattern: NOWHERE_MARKER, projectPath: repo });
    if (failed(nowhere)) {
      problems.push(`grep for a pattern found nowhere was an error: ${shown(nowhere)}`);
    } else if (nowhere.text.includes(NOTHING_IN_FOCUS_LEAD)) {
      problems.push(`grep for a pattern found nowhere answered the nothing-in-focus sentence, not the zero-hit note: ${shown(nowhere)}`);
    } else if (!nowhere.text.startsWith(`no hits for "${NOWHERE_MARKER}"`)) {
      problems.push(`grep for a pattern found nowhere did not answer the zero-hit note: ${shown(nowhere)}`);
    }

    const json = await focused.tool(GREP, { pattern: SHARED_MARKER, json: true, projectPath: repo });
    const result = failed(json) ? null : parseJsonObject(json.text);
    if (result === null) {
      problems.push(`grep json in focus did not parse as a JSON object: ${shown(json)}`);
    } else {
      const groups = Array.isArray(result.groups) ? (result.groups as GrepJsonGroup[]) : [];
      if (groups.length === 0) problems.push(`grep json in focus has no groups: ${shown(json)}`);
      const outsidePaths = new Set<string>();
      for (const group of groups) {
        for (const p of [group.path, group.symbol?.path]) {
          if (typeof p === 'string' && !p.startsWith('src/app/')) outsidePaths.add(p);
        }
      }
      for (const p of outsidePaths) problems.push(`grep json in focus has a group outside src/app: ${p}`);
      if (!groups.some((group) => group.path === 'src/app/app.ts')) problems.push(`grep json in focus has no group for src/app/app.ts: ${shown(json)}`);
    }

    expect(problems, 'G1-grep problems (empty when grep stays inside src/app, scope "repo" widens it, and both sentences are answered as specified)').toEqual([]);
  }, 150_000);

  // G2: a focused blast covers the whole repository. The in-focus dependent comes first and the outside one follows
  // the heading, in text and markdown. In json, outsideFocus holds the outside dependent and modules holds only the
  // in-focus one.
  it('G2-blast: a focused blast lists the outside-focus dependent under "## Outside focus (", in text, markdown and json', async () => {
    const problems: string[] = [];

    for (const format of ['text', 'markdown'] as const) {
      const ans = await focused.tool(BLAST, { format, projectPath: repo });
      problems.push(...outsideOrderProblems(`blast ${format} in focus`, ans));
    }

    const json = await focused.tool(BLAST, { format: 'json', projectPath: repo });
    if (failed(json)) {
      problems.push(`blast json in focus was an error: ${shown(json)}`);
    } else {
      const report = parseJsonObject(json.text);
      if (report === null) {
        problems.push(`blast json in focus is not a JSON object: ${shown(json)}`);
      } else {
        const inFocusNames = symbolNames(report.modules);
        if (!inFocusNames.includes('appCaller')) {
          problems.push(`blast json in focus: modules do not name appCaller (modules name ${JSON.stringify(inFocusNames)})`);
        }
        if (inFocusNames.includes('libCaller')) problems.push('blast json in focus: modules name libCaller, which is outside the focus');
        const outside = report.outsideFocus as { count?: unknown; modules?: unknown } | undefined;
        // outsideFocus.count counts symbols (dependents), as host's "## Outside focus (N)" counts nodes.
        if (outside?.count !== 1) {
          problems.push(`blast json in focus: outsideFocus.count is ${JSON.stringify(outside?.count)}, expected 1`);
        }
        const outsideNames = symbolNames(outside?.modules);
        if (!outsideNames.includes('libCaller')) {
          problems.push(`blast json in focus: outsideFocus.modules do not name libCaller (they name ${JSON.stringify(outsideNames)})`);
        }
      }
    }

    expect(problems, 'G2-blast problems (empty when blast lists every dependent and the outside-focus part sits after the heading)').toEqual([]);
  }, 150_000);

  // G3: orphans and suspects ignore the focus. Each answer in focus is the unfocused answer byte for byte, and the
  // out-of-focus item (libUnused in src/lib, the call edge from libCaller) is in both.
  it('G3-orphans-suspects: orphans and suspects answer byte for byte the same in focus as unfocused, out-of-focus items included', async () => {
    const cases: Array<{ label: string; tool: string; args: Record<string, unknown>; mustContain: string }> = [
      { label: 'orphans (text)', tool: ORPHANS, args: { base: 'HEAD~1', projectPath: repo }, mustContain: 'libUnused' },
      { label: 'orphans (json)', tool: ORPHANS, args: { base: 'HEAD~1', format: 'json', projectPath: repo }, mustContain: 'libUnused' },
      { label: 'suspects (text)', tool: SUSPECTS, args: { projectPath: repo }, mustContain: 'libCaller' },
      { label: 'suspects (json)', tool: SUSPECTS, args: { format: 'json', projectPath: repo }, mustContain: 'libCaller' },
    ];
    const problems: string[] = [];
    for (const { label, tool, args, mustContain } of cases) {
      const base = await unfocused.tool(tool, args);
      const inFocus = await focused.tool(tool, args);
      if (failed(base) || !base.text.includes(mustContain)) {
        problems.push(`${label} with no focus did not answer with "${mustContain}": ${shown(base)}`);
      }
      if (inFocus.text !== base.text || inFocus.isError !== base.isError || inFocus.rpcError !== base.rpcError) {
        problems.push(`${label} differs in focus: ${shown(inFocus)} (unfocused: ${shown(base)})`);
      } else if (failed(inFocus) || !inFocus.text.includes(mustContain)) {
        problems.push(`${label} in focus dropped "${mustContain}": ${shown(inFocus)}`);
      }
    }

    expect(problems, 'G3-orphans-suspects problems (empty when orphans and suspects answer the same in focus as unfocused)').toEqual([]);
  }, 150_000);

  // G4: with no focus, grep and blast answer exactly the pinned answers. The NO_FOCUS_* pins
  // at the end of this file hold those answers. The session's answer must equal each pin, and the handler run in this
  // process must equal it too, so the server and the handler agree. The no-focus answers carry none of the focus wording.
  it('G4-no-focus: an unfocused session answers grep and blast exactly as the pinned answers', async () => {
    const problems: string[] = [];
    const inProcess = {
      grepText: textOf(await handleGrepTool({ pattern: SHARED_MARKER }, repo)),
      grepJson: textOf(await handleGrepTool({ pattern: SHARED_MARKER, json: true }, repo)),
      blastText: textOf(blastToolHandler({ projectPath: repo, format: 'text' })),
      blastMarkdown: textOf(blastToolHandler({ projectPath: repo, format: 'markdown' })),
      blastJson: textOf(blastToolHandler({ projectPath: repo, format: 'json' })),
    };
    const cases: Array<{ label: string; tool: string; args: Record<string, unknown>; pinned: string; handler: string }> = [
      { label: 'grep (text)', tool: GREP, args: { pattern: SHARED_MARKER, projectPath: repo }, pinned: NO_FOCUS_GREP_TEXT, handler: inProcess.grepText },
      { label: 'grep (json)', tool: GREP, args: { pattern: SHARED_MARKER, json: true, projectPath: repo }, pinned: NO_FOCUS_GREP_JSON, handler: inProcess.grepJson },
      { label: 'blast (text)', tool: BLAST, args: { format: 'text', projectPath: repo }, pinned: NO_FOCUS_BLAST_TEXT, handler: inProcess.blastText },
      { label: 'blast (markdown)', tool: BLAST, args: { format: 'markdown', projectPath: repo }, pinned: NO_FOCUS_BLAST_MARKDOWN, handler: inProcess.blastMarkdown },
      { label: 'blast (json)', tool: BLAST, args: { format: 'json', projectPath: repo }, pinned: NO_FOCUS_BLAST_JSON, handler: inProcess.blastJson },
    ];
    for (const { label, tool, args, pinned, handler } of cases) {
      if (handler !== pinned) {
        problems.push(`${label}: the handler in this process differs from its pinned no-focus answer: ${JSON.stringify(handler)}`);
      }
      const ans = await unfocused.tool(tool, args);
      if (failed(ans)) {
        problems.push(`${label} with no focus was an error: ${shown(ans)}`);
      } else if (ans.text !== pinned) {
        problems.push(`${label} with no focus differs from its pinned answer: session ${shown(ans)}, pinned ${JSON.stringify(pinned)}`);
      }
      if (ans.text.includes('Outside focus') || ans.text.includes('scope: "repo"')) {
        problems.push(`${label} with no focus carries focus wording: ${shown(ans)}`);
      }
    }

    expect(problems, 'G4-no-focus problems (empty when an unfocused session answers grep and blast exactly as the pins, and the handler agrees)').toEqual([]);
  }, 150_000);

  // G5: a sibling worktree of the same repository, asked about through a session launched in the anchor with the focus.
  // The sibling's files differ from the anchor's: its branch commits siblingAppCaller() in src/app/app.ts and
  // siblingLibCaller() in src/lib/lib.ts, both calling target() with SIBLING_ONLY_MARKER, and its target() body carries
  // the same uncommitted edit as the anchor's. So an answer taken from the anchor's index or files cannot pass: the
  // marker is in no file of the anchor, and the sibling's own callers are missing from the anchor's blast. The sibling
  // has no index of its own: its first call seeds one from the anchor's and then catches up to the sibling's files, so
  // the test polls blast until the sibling's own callers appear before it judges the focused answers.
  it('G5-sibling-worktree: a focused session asked about a sibling worktree narrows grep to its src/app and lists blast\'s outside dependent after the heading', async () => {
    const sibling = fx.addWorktree(repo, 'focus-sibling', path.join(root, 'sibling'));
    fx.commitFiles(sibling, { 'src/app/app.ts': SIBLING_APP_TS, 'src/lib/lib.ts': SIBLING_LIB_TS }, 'sibling-only callers');
    fs.writeFileSync(path.join(sibling, 'src/shared/target.ts'), TARGET_TS_EDITED);
    const problems: string[] = [];

    const deadline = Date.now() + 120_000;
    let warm: ToolAnswer | undefined;
    while (Date.now() < deadline) {
      warm = await focused.tool(BLAST, { format: 'text', projectPath: sibling });
      if (!failed(warm) && warm.text.includes(SIBLING_APP_CALLER) && warm.text.includes(SIBLING_LIB_CALLER)) break;
      await sleep(500);
    }
    if (warm === undefined || failed(warm) || !warm.text.includes(SIBLING_APP_CALLER) || !warm.text.includes(SIBLING_LIB_CALLER)) {
      problems.push(`the sibling worktree never answered blast from its own callers within 120 s: ${warm === undefined ? 'no answer' : shown(warm)}`);
    }

    const grep = await focused.tool(GREP, { pattern: SIBLING_ONLY_MARKER, projectPath: sibling });
    if (failed(grep)) problems.push(`grep of the sibling worktree in focus was an error: ${shown(grep)}`);
    if (!grep.text.includes('src/app/app.ts') || !grep.text.includes(SIBLING_APP_CALLER)) {
      problems.push(`grep of the sibling worktree in focus did not return its src/app hit (${SIBLING_APP_CALLER}): ${shown(grep)}`);
    }
    if (grep.text.includes('src/lib/')) problems.push(`grep of the sibling worktree in focus returned its src/lib hit: ${shown(grep)}`);

    const wide = await focused.tool(GREP, { pattern: SIBLING_ONLY_MARKER, scope: 'repo', projectPath: sibling });
    if (failed(wide)) problems.push(`grep of the sibling worktree with scope "repo" was an error: ${shown(wide)}`);
    if (!wide.text.includes('src/app/app.ts') || !wide.text.includes('src/lib/lib.ts')) {
      problems.push(`grep of the sibling worktree with scope "repo" did not return hits in both src/app and src/lib: ${shown(wide)}`);
    }

    const blast = await focused.tool(BLAST, { format: 'text', projectPath: sibling });
    problems.push(...outsideOrderProblems('blast text of the sibling worktree in focus', blast, SIBLING_APP_CALLER, SIBLING_LIB_CALLER));

    expect(problems, 'G5-sibling-worktree problems (empty when the focus applies to the sibling worktree the call names)').toEqual([]);
  }, 150_000);
});

/*
 * The no-focus answers of grep and blast on the fixture above, as the handlers print them with no session focus. An
 * intended change to unfocused grep or blast output must update them.
 * G4 compares the unfocused session against them. They were captured from the built handlers, on this fixture (the same
 * files, commits, index and target() edit as beforeAll), and pasted in verbatim. Two captures in separate temp
 * directories were byte-identical, with no temp path, timestamp or random value, so nothing in them is normalised.
 */

const NO_FOCUS_GREP_TEXT = [
  "\"focus-grep-marker\" — 2 hits in 2 symbols across 2 files (searched 3 indexed files)",
  "",
  "appCaller · function · src/app/app.ts:L1-L3 · 0 in-edges",
  "  L2: return target() + \" focus-grep-marker\";",
  "",
  "libCaller · function · src/lib/lib.ts:L1-L3 · 0 in-edges",
  "  L2: return target() + \" focus-grep-marker lib-only-marker\";",
  "",
].join('\n');

const NO_FOCUS_GREP_JSON = [
  "{",
  "  \"pattern\": \"focus-grep-marker\",",
  "  \"filesSearched\": 3,",
  "  \"totalHits\": 2,",
  "  \"groups\": [",
  "    {",
  "      \"symbol\": {",
  "        \"id\": \"src/app/app.ts#appCaller\",",
  "        \"name\": \"appCaller\",",
  "        \"kind\": \"function\",",
  "        \"path\": \"src/app/app.ts\",",
  "        \"span\": \"L1-L3\"",
  "      },",
  "      \"path\": \"src/app/app.ts\",",
  "      \"inDegree\": 0,",
  "      \"hits\": [",
  "        {",
  "          \"line\": 2,",
  "          \"text\": \"return target() + \\\" focus-grep-marker\\\";\"",
  "        }",
  "      ]",
  "    },",
  "    {",
  "      \"symbol\": {",
  "        \"id\": \"src/lib/lib.ts#libCaller\",",
  "        \"name\": \"libCaller\",",
  "        \"kind\": \"function\",",
  "        \"path\": \"src/lib/lib.ts\",",
  "        \"span\": \"L1-L3\"",
  "      },",
  "      \"path\": \"src/lib/lib.ts\",",
  "      \"inDegree\": 0,",
  "      \"hits\": [",
  "        {",
  "          \"line\": 2,",
  "          \"text\": \"return target() + \\\" focus-grep-marker lib-only-marker\\\";\"",
  "        }",
  "      ]",
  "    }",
  "  ],",
  "  \"truncated\": {",
  "    \"files\": 0,",
  "    \"hits\": 0",
  "  },",
  "  \"saved\": {",
  "    \"files\": 2,",
  "    \"baselineChars\": 252",
  "  }",
  "}",
].join('\n');

const NO_FOCUS_BLAST_TEXT = [
  "blast radius — working tree vs HEAD (depth 2)",
  "  changed: 1 file in 1 area, 1 seed symbol",
  "  impacted: 2 symbols in 2 areas",
  "",
  "✗ target — 1 changed file, 0/1 reached by a test",
  "",
  "appCaller — 1 symbol in 1 file",
  "  calls ← appCaller (src/app/app.ts:L1-L3) [depth 1] [questionable]",
  "",
  "libCaller — 1 symbol in 1 file",
  "  calls ← libCaller (src/lib/lib.ts:L1-L3) [depth 1] [questionable]",
  "",
  "2 dependents reached only through name-matched calls are marked questionable; strict (`--strict`, or `strict: true` over MCP) leaves them out.",
  "",
].join('\n');

const NO_FOCUS_BLAST_MARKDOWN = [
  "### blast radius",
  "",
  "**1 area changed → 2 areas can be affected.** 2 dependent symbols, depth 2.",
  "Tests: **no test reaches target**.",
  "",
  "| Can be affected | Symbols | Nearest hop | Reached from |",
  "| --- | --: | --- | --- |",
  "| appCaller | 1 | `src/app/app.ts:L1-L3` appCaller — calls, depth 1, questionable | target |",
  "| libCaller | 1 | `src/lib/lib.ts:L1-L3` libCaller — calls, depth 1, questionable | target |",
  "",
  "<details>",
  "<summary><strong>All 2 dependent symbols</strong>, grouped by area</summary>",
  "",
  "**appCaller** — 1 symbol in 1 file",
  "",
  "- `src/app/app.ts:L1-L3` — appCaller (calls, depth 1, questionable)",
  "",
  "**libCaller** — 1 symbol in 1 file",
  "",
  "- `src/lib/lib.ts:L1-L3` — libCaller (calls, depth 1, questionable)",
  "",
  "</details>",
  "<details>",
  "<summary><strong>Test signal</strong> per changed area — 1 ✗</summary>",
  "",
  "_Reached = a node under a test path has a resolved edge into the changed symbol. It undercounts anything called indirectly — through a CLI, a spawned process or a dynamic import — so read a low ratio as “look here”, never as a coverage gate._",
  "",
  "- ✗ **target** — 0 of 1 reached · no test file reaches it",
  "  - not reached: `target`",
  "",
  "</details>",
  "",
  "2 dependents reached only through name-matched calls are marked questionable; strict (`--strict`, or `strict: true` over MCP) leaves them out.",
  "",
  "<sub>`codegraph blast` · working tree vs HEAD · depth 2 · 1 changed file</sub>",
  "",
].join('\n');

const NO_FOCUS_BLAST_JSON = [
  "{",
  "  \"basis\": \"working tree vs HEAD\",",
  "  \"depth\": 2,",
  "  \"changed\": [",
  "    {",
  "      \"path\": \"src/shared/target.ts\",",
  "      \"status\": \"modified\",",
  "      \"ranges\": [",
  "        {",
  "          \"start\": 2,",
  "          \"end\": 2",
  "        }",
  "      ],",
  "      \"hunks\": [",
  "        {",
  "          \"start\": 2,",
  "          \"end\": 2,",
  "          \"lines\": [",
  "            {",
  "              \"n\": null,",
  "              \"sign\": \"-\"",
  "            },",
  "            {",
  "              \"n\": 2,",
  "              \"sign\": \"+\"",
  "            }",
  "          ],",
  "          \"dropped\": 0",
  "        }",
  "      ]",
  "    }",
  "  ],",
  "  \"unindexed\": [],",
  "  \"deleted\": [],",
  "  \"seeds\": [",
  "    {",
  "      \"id\": \"function:f8e18f4d92779103b32dfaf548bf8e30\",",
  "      \"name\": \"target\",",
  "      \"kind\": \"function\",",
  "      \"path\": \"src/shared/target.ts\",",
  "      \"span\": \"L1-L3\",",
  "      \"wholeFile\": false",
  "    }",
  "  ],",
  "  \"impacted\": [",
  "    {",
  "      \"id\": \"function:58370be906952274dc09db48e3d06df3\",",
  "      \"name\": \"libCaller\",",
  "      \"kind\": \"function\",",
  "      \"path\": \"src/lib/lib.ts\",",
  "      \"span\": \"L1-L3\",",
  "      \"relation\": \"calls\",",
  "      \"depth\": 1,",
  "      \"questionable\": true",
  "    },",
  "    {",
  "      \"id\": \"function:f3dae74d2d826ec9cbb1397f0047db86\",",
  "      \"name\": \"appCaller\",",
  "      \"kind\": \"function\",",
  "      \"path\": \"src/app/app.ts\",",
  "      \"span\": \"L1-L3\",",
  "      \"relation\": \"calls\",",
  "      \"depth\": 1,",
  "      \"questionable\": true",
  "    }",
  "  ],",
  "  \"modules\": [",
  "    {",
  "      \"label\": \"appCaller\",",
  "      \"labelSource\": \"symbol\",",
  "      \"key\": \"src/app/\",",
  "      \"files\": [",
  "        \"src/app/app.ts\"",
  "      ],",
  "      \"symbols\": [",
  "        {",
  "          \"id\": \"function:f3dae74d2d826ec9cbb1397f0047db86\",",
  "          \"name\": \"appCaller\",",
  "          \"kind\": \"function\",",
  "          \"path\": \"src/app/app.ts\",",
  "          \"span\": \"L1-L3\",",
  "          \"relation\": \"calls\",",
  "          \"depth\": 1,",
  "          \"questionable\": true",
  "        }",
  "      ],",
  "      \"from\": [",
  "        \"src/shared/target.ts\"",
  "      ]",
  "    },",
  "    {",
  "      \"label\": \"libCaller\",",
  "      \"labelSource\": \"symbol\",",
  "      \"key\": \"src/lib/\",",
  "      \"files\": [",
  "        \"src/lib/lib.ts\"",
  "      ],",
  "      \"symbols\": [",
  "        {",
  "          \"id\": \"function:58370be906952274dc09db48e3d06df3\",",
  "          \"name\": \"libCaller\",",
  "          \"kind\": \"function\",",
  "          \"path\": \"src/lib/lib.ts\",",
  "          \"span\": \"L1-L3\",",
  "          \"relation\": \"calls\",",
  "          \"depth\": 1,",
  "          \"questionable\": true",
  "        }",
  "      ],",
  "      \"from\": [",
  "        \"src/shared/target.ts\"",
  "      ]",
  "    }",
  "  ],",
  "  \"testModules\": [],",
  "  \"areas\": [",
  "    {",
  "      \"label\": \"target\",",
  "      \"labelSource\": \"symbol\",",
  "      \"key\": \"src/shared/\",",
  "      \"files\": [",
  "        \"src/shared/target.ts\"",
  "      ],",
  "      \"seeds\": 1,",
  "      \"tests\": \"none\",",
  "      \"testFiles\": [],",
  "      \"changedTestFiles\": [],",
  "      \"reached\": 0,",
  "      \"behavioural\": 1,",
  "      \"unreached\": [",
  "        \"target\"",
  "      ],",
  "      \"seedNames\": [",
  "        \"target\"",
  "      ]",
  "    }",
  "  ]",
  "}",
  "",
].join('\n');
