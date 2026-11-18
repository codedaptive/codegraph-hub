/**
 * Tokens of one Python path expression, for pythonPathExpression to evaluate.
 *
 * Only what a static file path is written with: plain, raw or unicode string literals,
 * identifiers, integers and the punctuation `( ) [ ] . , / =`. Any other character
 * (`+`, `%`, `{`) means the path is computed, so the whole expression is refused with
 * null. A name directly followed by a quote is a string prefix other than `r`/`u`
 * (an f-string, a bytes literal), and is refused too. A string holding a backslash is
 * refused: its escapes or Windows separators are not a POSIX path written as is.
 */
import type { PathToken } from './python-path-token';

const TOKEN = /\s+|[rRuU]?(["'])((?:(?!\1)[^\\\n])*)\1|([A-Za-z_]\w*)(?!["'])|(\d+)|([()[\].,/=])/y;

export function pythonPathTokens(expression: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.length) {
    const match = TOKEN.exec(expression);
    if (!match) return null;
    if (match[1] !== undefined) tokens.push({ kind: 'string', text: match[2] ?? '' });
    else if (match[3] !== undefined) tokens.push({ kind: 'name', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: 'number', text: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: 'punct', text: match[5] });
  }
  return tokens;
}
