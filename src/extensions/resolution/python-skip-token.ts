/**
 * One step of a top-level walk over Python source already through stripCommentsForRegex
 * (comments and triple-quoted strings blanked): the index just past the token at `i`.
 *
 * A token is a whole single-line string, a whole bracketed group (nested groups and the
 * strings inside it skipped too), or one character. Why: a walk that steps with it sees
 * only what stands at bracket depth 0, so the commas and ')' inside a nested call are not
 * an argument list's, and a newline inside brackets does not end a logical line. Past the
 * end when a group never closes.
 */

export function pythonSkipToken(source: string, i: number): number {
  const c = source[i];
  if (c === '"' || c === "'") return stringEnd(source, i);
  if (c !== '(' && c !== '[' && c !== '{') return i + 1;
  let j = i + 1;
  while (j < source.length && !')]}'.includes(source[j] ?? '')) j = pythonSkipToken(source, j);
  return j + 1;
}

/**
 * Index just past the single-line string opened at `open`; at the newline when it is
 * unterminated, so that newline still ends its line.
 */
function stringEnd(source: string, open: number): number {
  let i = open + 1;
  while (i < source.length && source[i] !== source[open] && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
  return source[i] === source[open] ? i + 1 : i;
}
