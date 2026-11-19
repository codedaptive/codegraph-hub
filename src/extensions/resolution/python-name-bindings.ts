/**
 * Every place a Python file may bind each word, as a map from the word to the logical line
 * of each such occurrence (once per occurrence); null when the file reaches its namespace
 * dynamically, so that no name in it can be known.
 *
 * Source is read through stripCommentsForRegex. An occurrence of a word counts as a
 * possible binding when:
 * - the next text past spaces and '\' is `=` (not `==`), an augmented operator or `:`;
 * - one of def class lambda for as import global nonlocal del case stands earlier on its
 *   logical line;
 * - a `=` at the line's bracket depth 0 (not `==`, `<=`, `>=`, `!=`) comes after it; or
 * - it sits inside a single-line string literal (`patch("m.ROOT")` names it).
 * The file is dynamic when it has `import *`, `sys.modules`, or one of the words globals,
 * vars, locals, exec, eval, setattr, __dict__ (`exec_module` is another word).
 *
 * Why: a reader that recognises binding forms one by one fails open on each form it
 * misses. Here any occurrence not plainly a read counts, so a form nobody listed can only
 * make a name unknown, never give it a wrong value.
 */
import { pythonLogicalLines } from './python-logical-lines';
import { pythonSkipToken } from './python-skip-token';

const DYNAMIC = /\b(?:globals|vars|locals|exec|eval|setattr|__dict__)\b|\bsys\s*\.\s*modules\b|\bimport\s+\*/;
const KEYWORDS = new Set(['def', 'class', 'lambda', 'for', 'as', 'import', 'global', 'nonlocal', 'del', 'case']);
const WORD = /[A-Za-z_]\w*/g;
const BINDS_AFTER = /[\s\\]*(?:=(?!=)|:|(?:\/\/|\*\*|>>|<<|[-+*/%@&|^])=)/y;

export function pythonNameBindings(source: string): Map<string, string[]> | null {
  if (DYNAMIC.test(source)) return null;
  const sites = new Map<string, string[]>();
  for (const line of pythonLogicalLines(source)) {
    for (const word of bindingWords(line)) sites.set(word, [...(sites.get(word) ?? []), line]);
  }
  return sites;
}

/** The words of one logical line at each occurrence that may bind it. */
function bindingWords(line: string): string[] {
  const assignment = lastAssignment(line);
  const strings = stringSpans(line);
  const words: string[] = [];
  let keyword = Infinity;
  for (const match of line.matchAll(WORD)) {
    const at = match.index ?? 0;
    BINDS_AFTER.lastIndex = at + match[0].length;
    if (keyword < at || at < assignment || BINDS_AFTER.test(line) || inside(strings, at)) words.push(match[0]);
    if (KEYWORDS.has(match[0])) keyword = Math.min(keyword, at);
  }
  return words;
}

/** Index of the last `=` at bracket depth 0 that is neither a comparison nor `==`; -1 when none. */
function lastAssignment(line: string): number {
  let last = -1;
  for (let i = 0; i < line.length; i = pythonSkipToken(line, i)) {
    if (line[i] === '=' && line[i + 1] !== '=' && !'=<>!'.includes(line[i - 1] ?? ' ')) last = i;
  }
  return last;
}

/** The [open quote, end) span of each single-line string literal in the line. */
function stringSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '"' && line[i] !== "'") continue;
    const end = pythonSkipToken(line, i);
    spans.push([i, end]);
    i = end - 1;
  }
  return spans;
}

function inside(spans: Array<[number, number]>, at: number): boolean {
  return spans.some(([open, end]) => open < at && at < end);
}
