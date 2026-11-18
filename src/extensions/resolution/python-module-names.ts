/**
 * The module names a Python file binds exactly once, to the expression text bound, read
 * from its logical lines (each with its indent and trimmed text).
 *
 * Module scope is every line outside a `def` or `class` body: a line's enclosing blocks
 * are the earlier lines still open at a smaller indent, and a line is in module scope
 * when none of them opens a def or class. The bodies of `if`, `try`, `for`, `with` and
 * the like stay in module scope, so a rebinding there counts. A class attribute does not.
 * A name is known only with one binding in module scope, and that one `name = value` on
 * one physical line. A name a function declares `global` may be rebound by any call to
 * it, so it is unknown everywhere. Why: pythonLoaderPaths evaluates loader paths against
 * these names, and a name with any other value at run time would make a false edge.
 */
import { pythonBoundNames } from './python-bound-names';

interface ScopedLine {
  indent: number;
  text: string;
}

const SCOPE_OPENER = /^(?:async\s+)?(?:def|class)\b/;
const GLOBAL = /^global\s+([\s\S]+)$/;
const MODULE_VALUE = /^[A-Za-z_]\w*[ \t]*=(?!=)([^\n]*)$/;

export function pythonModuleNames(lines: readonly ScopedLine[]): Map<string, string> {
  const bindings = new Map<string, string[]>();
  const globals = new Set<string>();
  const open: Array<{ indent: number; scope: boolean }> = [];
  for (const line of lines) {
    while ((open[open.length - 1]?.indent ?? -1) >= line.indent) open.pop();
    if (open.some((block) => block.scope)) {
      for (const name of GLOBAL.exec(line.text)?.[1]?.split(',') ?? []) globals.add(name.trim());
    } else {
      const value = MODULE_VALUE.exec(line.text)?.[1]?.trim() ?? '';
      for (const name of pythonBoundNames(line.text)) bindings.set(name, [...(bindings.get(name) ?? []), value]);
    }
    open.push({ indent: line.indent, scope: SCOPE_OPENER.test(line.text) });
  }
  const names = new Map<string, string>();
  for (const [name, values] of bindings) {
    if (values.length === 1 && values[0] && !globals.has(name)) names.set(name, values[0]);
  }
  return names;
}
