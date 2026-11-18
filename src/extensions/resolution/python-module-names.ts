/**
 * The names a Python file binds exactly once, each to the expression text bound, read from
 * the possible bindings pythonNameBindings found (null, a dynamic file, knows none).
 *
 * A name is known only when its one possible binding is a logical line `NAME = value`, at
 * any indent, with the value on that one physical line. Any second possible binding (a
 * rebinding in a block, a class body, a parameter, a `global` declaration, an import, a
 * name in a string) leaves it unknown. Why: with one textual binding and no dynamic
 * namespace access, every lookup of the name, in any scope, reads that value or none.
 * A name bound once may also be read where Python would raise NameError (before its
 * binding or outside its scope); the edge is still emitted, and it can only point at the
 * file's one bound value, which `affected` accepts as over-inclusion.
 */

const BINDING = /^([A-Za-z_]\w*)[ \t]*=(?!=)([^\n]*)$/;

export function pythonModuleNames(bindings: ReadonlyMap<string, readonly string[]> | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, lines] of bindings ?? []) {
    const binding = lines.length === 1 ? BINDING.exec(lines[0] ?? '') : null;
    if (binding?.[1] === name) names.set(name, (binding[2] ?? '').trim());
  }
  return names;
}
