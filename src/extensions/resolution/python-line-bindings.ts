/**
 * The names one Python logical line binds in the scope it stands in, read from its text
 * (trimmed, through stripCommentsForRegex): the target of `name =`, an annotated
 * `name: T =` or an augmented `name += v` (tuple targets included), a `for` target, every
 * `as` target (`with`, `except`, `import`), and the name of a `def` or `class`.
 *
 * Why: pythonLoaderPaths knows a module name at a loader call only when nothing else binds
 * it, at module level or in a function enclosing the call. A name read here that the line
 * does not really bind only makes a path unknown, never wrong, so the reading leans wide.
 * Attribute and subscript targets (`self.x =`, `d[k] =`) bind no name and are skipped, as
 * is a `=` inside a call's parentheses, which is a keyword argument.
 */

const DEF = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const FOR = /^(?:async\s+)?for\s+([\s\S]+?)\s+in\b/;
const AS = /\bas\s+(\([^)]*\)|[A-Za-z_]\w*)/g;
/** The target text before an assignment's `=`, augmented operator included; not `==`. */
const ASSIGN = /^([^=]*?)\s*(?:\/\/|\*\*|>>|<<|[-+*/%&|^@])?=(?!=)/;
const NAME = /^[A-Za-z_]\w*$/;

export function pythonLineBindings(text: string): string[] {
  const def = DEF.exec(text);
  if (def) return [def[1] ?? ''];
  const names = [...text.matchAll(AS)].flatMap((match) => targetNames(match[1] ?? ''));
  const loop = FOR.exec(text);
  if (loop) return [...targetNames(loop[1] ?? ''), ...names];
  const assign = ASSIGN.exec(text);
  const target = assign?.[1]?.split(':')[0] ?? '';
  if (target.includes('(') && !target.startsWith('(')) return names;
  return [...targetNames(target), ...names];
}

/** The plain names in a target list: `a`, `a, *b`, `(a, b)`; `self.x` and `d[k]` give none. */
function targetNames(target: string): string[] {
  return target.replace(/[()]/g, ' ')
    .split(',')
    .map((part) => part.trim().replace(/^\*/, ''))
    .filter((part) => NAME.test(part));
}
