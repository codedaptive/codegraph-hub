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
 * evaluated by pythonPathExpression against the module-level names: a name assigned
 * exactly once, at column 0, on one line. A name assigned more than once, or only
 * inside a function, is not known, so a path built from it is skipped.
 */
import { stripCommentsForRegex } from '../../resolution/strip-comments';
import { pythonPathExpression } from './python-path-expression';

export interface LoaderPath {
  line: number;
  name: string;
}

const LOADER_CALL = /\b(?:SourceFileLoader|spec_from_file_location)\s*\(/g;
/** A column-0 binding: plain, annotated (`X: T = v`) or augmented (`X += v`). */
const MODULE_ASSIGN = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?(=(?!=)|[-+*/%&|^@<>]{1,2}=)(.*)$/gm;
const PATH_KEYWORD = /^(?:path|location)\s*=(?!=)/;
const ANY_KEYWORD = /^\w+\s*=(?!=)/;

export function pythonLoaderPaths(filePath: string, content: string): LoaderPath[] {
  const source = stripCommentsForRegex(content, 'python');
  const names = moduleNames(source);
  const found: LoaderPath[] = [];
  let line = 1;
  let counted = 0;
  for (const call of source.matchAll(LOADER_CALL)) {
    const start = call.index ?? 0;
    for (; counted < start; counted++) if (source[counted] === '\n') line++;
    const argument = pathArgument(callArguments(source, start + call[0].length));
    const name = argument === undefined ? null : pythonPathExpression(argument, filePath, names);
    if (name !== null) found.push({ line, name });
  }
  return found;
}

/** Names bound exactly once at module level, to the expression text bound. */
function moduleNames(source: string): Map<string, string> {
  const bindings = new Map<string, string[]>();
  for (const [, name = '', op, value = ''] of source.matchAll(MODULE_ASSIGN)) {
    const list = bindings.get(name) ?? [];
    list.push(op === '=' ? value.trim() : '');
    bindings.set(name, list);
  }
  const names = new Map<string, string>();
  for (const [name, values] of bindings) {
    if (values.length === 1 && values[0]) names.set(name, values[0]);
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
  let depth = 0;
  let start = from;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") i = closingQuote(source, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (depth > 0 && (c === ')' || c === ']' || c === '}')) depth--;
    else if (depth === 0 && (c === ',' || c === ')')) {
      const arg = source.slice(start, i).trim();
      if (arg !== '' || c === ',') args.push(arg);
      if (c === ')') return args;
      start = i + 1;
    }
  }
  return null;
}

/** Index of the quote closing the single-line string opened at `open`. */
function closingQuote(source: string, open: number): number {
  let i = open + 1;
  while (i < source.length && source[i] !== source[open] && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
  return i;
}
