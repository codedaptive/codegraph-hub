/**
 * The PathTrust of a Python file, from the possible bindings pythonNameBindings found
 * (null, a dynamic file, trusts nothing).
 *
 * `__file__` is trusted when nothing may bind it. A bare callee pythonPathExpression reads
 * (Path, dirname, join, …) is trusted when each of its possible bindings is a plain
 * `from os|os.path|posixpath|pathlib import …` of it. A word a dotted callee is made of
 * (os, path, posixpath, pathlib or a callee name) is trusted when each of its possible
 * bindings is such a from-import or a plain `import …` of it, so `mock.patch.object(os.path,
 * "join", …)` (a string occurrence) or `mod.path = fake` leaves `os.path.join` untrusted.
 * An `as` beside the word, or any other statement on the line, makes it untrusted.
 * A word nothing may bind is trusted: `str` is the builtin, and any other is read where
 * Python would raise NameError; the edge is still emitted, and `affected` accepts it as
 * over-inclusion. Why: a callee bound to anything else computes something else, and
 * evaluating it as the library function makes a false edge.
 */
import type { PathTrust } from './python-path-trust';

const CALLEES = ['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath', 'dirname', 'join'];
const DOTTED = [...CALLEES, 'os', 'path', 'posixpath', 'pathlib'];
const FROM_IMPORT = /^from\s+(?:os|os\.path|posixpath|pathlib)\s+import\s+[\w\s,()\\]+$/;
const IMPORT = /^import\s+[\w\s,.\\]+$/;

export function pythonTrust(bindings: ReadonlyMap<string, readonly string[]> | null): PathTrust {
  if (!bindings) return { file: false, names: new Set(), dotted: new Set() };
  const trusted = (...statements: RegExp[]) => (name: string) => importedOnly(name, bindings.get(name) ?? [], statements);
  return {
    file: !bindings.has('__file__'),
    names: new Set(CALLEES.filter(trusted(FROM_IMPORT))),
    dotted: new Set(DOTTED.filter(trusted(FROM_IMPORT, IMPORT))),
  };
}

/** True when every line that may bind `name` (none included) is an unaliased import of one of `statements`. */
function importedOnly(name: string, lines: readonly string[], statements: readonly RegExp[]): boolean {
  const aliased = new RegExp(`\\b${name}\\s+as\\b|\\bas\\s+${name}\\b`);
  return lines.every((line) => statements.some((statement) => statement.test(line)) && !aliased.test(line));
}
