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
 * evaluated by pythonPathExpression against the names pythonModuleNames knows and the
 * trust pythonTrust gives, both read from the occurrences pythonNameBindings counts as
 * possible bindings. A name is known only when its one possible binding is a one-line
 * `NAME = value` and the file reaches no namespace dynamically, so its value is the same
 * at every call, in any scope; anything else leaves it unknown. A path built from an
 * unknown name or an untrusted callee is skipped.
 */
import { stripCommentsForRegex } from '../../resolution/strip-comments';
import { pythonModuleNames } from './python-module-names';
import { pythonNameBindings } from './python-name-bindings';
import { pythonPathExpression } from './python-path-expression';
import { pythonSkipToken } from './python-skip-token';
import { pythonTrust } from './python-trust';

interface LoaderPath {
  line: number;
  name: string;
}

const LOADER_CALL = /\b(?:SourceFileLoader|spec_from_file_location)\s*\(/g;
const PATH_KEYWORD = /^(?:path|location)\s*=(?!=)/;
const ANY_KEYWORD = /^\w+\s*=(?!=)/;

export function pythonLoaderPaths(filePath: string, content: string): LoaderPath[] {
  const source = stripCommentsForRegex(content, 'python');
  const calls = [...source.matchAll(LOADER_CALL)];
  if (calls.length === 0) return [];
  const bindings = pythonNameBindings(source);
  const names = pythonModuleNames(bindings);
  const trust = pythonTrust(bindings);
  const found: LoaderPath[] = [];
  let line = 1;
  let counted = 0;
  for (const call of calls) {
    const start = call.index ?? 0;
    for (; counted < start; counted++) if (source[counted] === '\n') line++;
    const argument = pathArgument(callArguments(source, start + call[0].length));
    const name = argument === undefined ? null : pythonPathExpression(argument, filePath, names, trust);
    if (name !== null) found.push({ line, name });
  }
  return found;
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
