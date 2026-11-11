/**
 * Focus-note unit tests: a focused explore answer ends with one line for each bare, identifier-shaped query name
 * (up to three) that the index defines outside the session focus and nowhere inside it. In-process, no stdio.
 *
 * The index is real: a committed git repository in a temp dir (the indexer reads git), with `.git` at its top, so
 * the focus `src/app` resolves against the repository as it does in a real worktree.
 * - U1: 'appEntry fooAlpha fooBeta fooGamma fooDelta' with the focus src/app ends with three lines, for fooAlpha,
 *   fooBeta and fooGamma in query order. fooDelta gets no line (the cap of three). appEntry, in focus, gets none.
 * - U2: a qualified token (lib.fooAlpha) gets no line, in a query whose other token is in focus and renders.
 * - U3: the focus filters the answer: appEntry's source is shown and fooAlpha's is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../../../src/index';
import { ToolHandler } from '../../../src/mcp/tools';
import { SESSION_FOCUS_ARG } from '../../../src/extensions/host/server/session-scope';

const APP_BODY = 'focus-note-app-entry-body';
const FOO_ALPHA_BODY = 'focus-note-foo-alpha-body';
/** The words every focus line shares after its name. A line is a focus line when it carries this sentence. */
const FOCUS_SENTENCE_MARK = "is defined in this index, outside this session's focus";

const FILES: Record<string, string> = {
  'src/app/a.ts': `export function appEntry(): string { return "${APP_BODY}"; }\n`,
  'src/lib/foos.ts':
    `export function fooAlpha(): string { return "${FOO_ALPHA_BODY}"; }\n` +
    'export function fooBeta(): string { return "focus-note-foo-beta-body"; }\n' +
    'export function fooGamma(): string { return "focus-note-foo-gamma-body"; }\n' +
    'export function fooDelta(): string { return "focus-note-foo-delta-body"; }\n',
};

/** The focus line for `name`: the name in backticks, then the sentence, on one line. */
function focusLine(name: string): string {
  return `\`${name}\` is defined in this index, outside this session's focus; pass scope: "repo" to include it.`;
}

/** The lines of an answer that carry the focus sentence, whatever the name. */
function focusLines(text: string): string[] {
  return text.split('\n').filter((line) => line.includes(FOCUS_SENTENCE_MARK));
}

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=focus-note-unit', '-c', 'user.email=unit@codegraph.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-focus-note-unit-')));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** One explore call through the handler, with the session focus src/app. */
async function exploreInFocus(query: string): Promise<{ text: string; isError: boolean }> {
  const result = await new ToolHandler(cg).execute(
    'codegraph_explore',
    { query, [SESSION_FOCUS_ARG]: ['src/app'] },
    undefined,
    { toolAllowlist: null },
  );
  return { text: result.content?.[0]?.text ?? '', isError: result.isError === true };
}

describe('focus note: a focused explore answer names the out-of-focus names it was asked for', () => {
  it('U1: ends with one line per out-of-focus name, in query order, at most three; the in-focus name gets none', async () => {
    const ans = await exploreInFocus('appEntry fooAlpha fooBeta fooGamma fooDelta');

    const problems: string[] = [];
    if (ans.isError) problems.push('the answer was an error');
    if (!ans.text.includes('appEntry') || !ans.text.includes(APP_BODY)) {
      problems.push('the in-focus appEntry source is not in the answer');
    }
    const lines = ans.text.trimEnd().split('\n');
    const expectedTail = [focusLine('fooAlpha'), focusLine('fooBeta'), focusLine('fooGamma')];
    if (JSON.stringify(lines.slice(-3)) !== JSON.stringify(expectedTail)) {
      problems.push(`the answer does not end with the three focus lines; its last lines are ${JSON.stringify(lines.slice(-4))}`);
    }
    if (lines[lines.length - 4] !== '') {
      problems.push(`the focus lines are not set off by one blank line; the line before them is ${JSON.stringify(lines[lines.length - 4])}`);
    }
    if (focusLines(ans.text).length !== 3) {
      problems.push(`expected three focus lines, found ${focusLines(ans.text).length}: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'U1 problems (empty when the answer ends with the fooAlpha, fooBeta and fooGamma lines and nothing else)')
      .toEqual([]);
  }, 60_000);

  it('U2: a qualified token (lib.fooAlpha) gets no line, beside an in-focus name that renders', async () => {
    const ans = await exploreInFocus('appEntry lib.fooAlpha');

    const problems: string[] = [];
    if (ans.isError) problems.push('the answer was an error');
    // The answer must be the rendered one: the in-focus name is in it, so the absence below is about the note.
    if (!ans.text.includes(APP_BODY)) problems.push('the in-focus appEntry source is not in the answer');
    if (focusLines(ans.text).length > 0) {
      problems.push(`a qualified token got a focus line: ${JSON.stringify(focusLines(ans.text))}`);
    }
    expect(problems, 'U2 problems (empty when the answer renders appEntry and has no focus line)').toEqual([]);
  }, 60_000);

  it('U3: the focus filters the answer: appEntry source is shown and fooAlpha source is not', async () => {
    const ans = await exploreInFocus('appEntry fooAlpha');

    const problems: string[] = [];
    if (ans.isError) problems.push('the answer was an error');
    if (!ans.text.includes(APP_BODY)) problems.push('the in-focus appEntry source is not in the answer');
    if (ans.text.includes(FOO_ALPHA_BODY)) problems.push('fooAlpha source is in the answer, so the focus did not filter it');
    if (ans.text.includes('src/lib/')) problems.push('the answer names a src/lib path');
    expect(problems, 'U3 problems (empty when appEntry is shown and nothing from src/lib is)').toEqual([]);
  }, 60_000);
});
