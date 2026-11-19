/**
 * The logical lines of Python source already through stripCommentsForRegex, each trimmed,
 * with the blank ones left out.
 *
 * A logical line ends at a newline that stands at bracket depth 0 and follows no '\'; the
 * walk steps with pythonSkipToken, so a newline inside brackets continues the line. Why: a
 * binding or a keyword on a continuation line belongs to the statement it continues.
 * Unclosed brackets run the last line to the end of the source.
 */
import { pythonSkipToken } from './python-skip-token';

export function pythonLogicalLines(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; ; i = pythonSkipToken(source, i)) {
    const end = Math.min(i, source.length);
    if (end < source.length && (source[end] !== '\n' || source[end - 1] === '\\')) continue;
    const text = source.slice(start, end).trim();
    if (text !== '') lines.push(text);
    if (end === source.length) return lines;
    start = end + 1;
  }
}
