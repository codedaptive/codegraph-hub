/**
 * The files a Python module loads by path: each `SourceFileLoader(name, path)` and
 * `spec_from_file_location(name, location)` call (under any dotted prefix) whose path
 * argument evaluates statically, with the 1-based line the call starts on.
 *
 * Why: such a module depends on the loaded file the way an import does, and no import
 * statement names it, so the file graph misses the edge. The source is read through
 * stripCommentsForRegex, which blanks comments and triple-quoted strings in place, so a
 * call in a comment or docstring is not read and offsets still give the right line.
 *
 * The path is the 2nd positional argument or the `path=` / `location=` keyword. It is
 * evaluated by pythonPathExpression against the module names pythonModuleNames reads from
 * the logical lines. A line that starts inside an open bracket continues the line before
 * and binds nothing. A name a
 * function enclosing the call binds (a parameter, or any binding in its body) is the
 * function's at that call, not the module's, so it is unknown there. A path built from
 * an unknown name is skipped.
 */
import { stripCommentsForRegex } from '../../resolution/strip-comments';
import { pythonBoundNames } from './python-bound-names';
import { pythonModuleNames } from './python-module-names';
import { pythonPathExpression } from './python-path-expression';
import { pythonSkipToken } from './python-skip-token';

interface LoaderPath {
  line: number;
  name: string;
}

/** A logical line: its offset, its indent, and its text trimmed (continuations included). */
interface LogicalLine {
  start: number;
  indent: number;
  text: string;
}

const LOADER_CALL = /\b(?:SourceFileLoader|spec_from_file_location)\s*\(/g;
const DEF_OPEN = /^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;
const PARAMETER = /^\*{0,2}\s*([A-Za-z_]\w*)/;
const PATH_KEYWORD = /^(?:path|location)\s*=(?!=)/;
const ANY_KEYWORD = /^\w+\s*=(?!=)/;

export function pythonLoaderPaths(filePath: string, content: string): LoaderPath[] {
  const source = stripCommentsForRegex(content, 'python');
  const lines = logicalLines(source);
  const names = pythonModuleNames(lines);
  const found: LoaderPath[] = [];
  let line = 1;
  let counted = 0;
  let at = 0;
  for (const call of source.matchAll(LOADER_CALL)) {
    const start = call.index ?? 0;
    for (; counted < start; counted++) if (source[counted] === '\n') line++;
    while ((lines[at + 1]?.start ?? Infinity) <= start) at++;
    const local = localNames(source, lines, at);
    const visible = new Map([...names].filter(([name]) => !local.has(name)));
    const argument = pathArgument(callArguments(source, start + call[0].length));
    const name = argument === undefined ? null : pythonPathExpression(argument, filePath, visible);
    if (name !== null) found.push({ line, name });
  }
  return found;
}

/** Logical lines with code, split at newlines that stand at bracket depth 0 and follow no '\'. */
function logicalLines(source: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;
  for (let i = 0; i <= source.length; i = pythonSkipToken(source, i)) {
    if ((i < source.length && source[i] !== '\n') || source[i - 1] === '\\') continue;
    const raw = source.slice(start, i);
    const text = raw.trim();
    if (text !== '') lines.push({ start, indent: raw.length - raw.trimStart().length, text });
    start = i + 1;
  }
  return lines;
}

/**
 * Names bound in every `def` enclosing lines[at]. Walking back from the call's line, each
 * line indented less than every line seen so far opens a block enclosing the call; the
 * walk stops at column 0. The call's own line counts, for a one-line def.
 */
function localNames(source: string, lines: LogicalLine[], at: number): Set<string> {
  const local: string[] = [];
  let indent = (lines[at]?.indent ?? 0) + 1;
  for (let i = at; i >= 0 && indent > 0; i--) {
    const line = lines[i];
    if (!line || line.indent >= indent) continue;
    indent = line.indent;
    local.push(...defNames(source, lines, i));
  }
  return new Set(local);
}

/** The parameters and body bindings of the def on lines[i]; none when it is not a def. */
function defNames(source: string, lines: LogicalLine[], i: number): string[] {
  const def = lines[i];
  const open = def && DEF_OPEN.exec(def.text);
  if (!def || !open) return [];
  const parameters = callArguments(source, def.start + def.indent + open[0].length) ?? [];
  const names = parameters.flatMap((parameter) => PARAMETER.exec(parameter)?.[1] ?? []);
  for (let body = i + 1; (lines[body]?.indent ?? 0) > def.indent; body++) {
    names.push(...pythonBoundNames(lines[body]?.text ?? ''));
  }
  return names;
}

function pathArgument(args: string[] | null): string | undefined {
  if (!args) return undefined;
  const keyword = args.find((arg) => PATH_KEYWORD.test(arg));
  if (keyword !== undefined) return keyword.slice(keyword.indexOf('=') + 1);
  return args.filter((arg) => !ANY_KEYWORD.test(arg))[1];
}

/**
 * The top-level arguments of the call whose '(' ends just before `from`, trimmed, up to
 * its balancing ')' (across lines; quotes respected). Null when the call never closes.
 */
function callArguments(source: string, from: number): string[] | null {
  const args: string[] = [];
  let start = from;
  for (let i = from; i < source.length; i = pythonSkipToken(source, i)) {
    const c = source[i];
    if (c !== ',' && c !== ')') continue;
    const arg = source.slice(start, i).trim();
    if (arg !== '' || c === ',') args.push(arg);
    if (c === ')') return args;
    start = i + 1;
  }
  return null;
}
