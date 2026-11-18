/**
 * The PathTrust of a Python file, from the possible bindings pythonNameBindings found
 * (null, a dynamic file, trusts nothing).
 *
 * `__file__` is trusted when nothing may bind it. A bare callee pythonPathExpression reads
 * (Path, dirname, join, …) is trusted when each of its possible bindings is a plain
 * `from os|os.path|posixpath|pathlib import …` of it, and a module a dotted callee starts
 * with (os, posixpath, pathlib) when each is a plain `import …` of it. An `as` beside the
 * word, or any other statement on the line, makes it untrusted. A word nothing may bind is
 * trusted: `str` is the builtin, and any other raises NameError, so no file is loaded.
 * Why: a callee bound to anything else computes something else, and evaluating it as the
 * library function makes a false edge.
 */
import type { PathTrust } from './python-path-trust';

const CALLEES = ['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath', 'dirname', 'join'];
const MODULES = ['os', 'posixpath', 'pathlib'];
const FROM_IMPORT = /^from\s+(?:os|os\.path|posixpath|pathlib)\s+import\s+[\w\s,()\\]+$/;
const IMPORT = /^import\s+[\w\s,.\\]+$/;

export function pythonTrust(bindings: ReadonlyMap<string, readonly string[]> | null): PathTrust {
  if (!bindings) return { file: false, names: new Set() };
  const trusted = (statement: RegExp) => (name: string) => importedOnly(name, bindings.get(name) ?? [], statement);
  return {
    file: !bindings.has('__file__'),
    names: new Set([...CALLEES.filter(trusted(FROM_IMPORT)), ...MODULES.filter(trusted(IMPORT))]),
  };
}

/** True when every line that may bind `name` (none included) is an unaliased `statement` of it. */
function importedOnly(name: string, lines: readonly string[], statement: RegExp): boolean {
  const aliased = new RegExp(`\\b${name}\\s+as\\b|\\bas\\s+${name}\\b`);
  return lines.every((line) => statement.test(line) && !aliased.test(line));
}
