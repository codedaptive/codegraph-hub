/**
 * Unit tests of pythonPathTokens: a static path chain splits into string, name, number
 * and punctuation tokens (a raw string's prefix dropped), and an expression that is
 * computed or not a POSIX path as written (a backslash in a string, an f-string, a bytes
 * literal, `+`, `%`) is refused with null.
 */
import { describe, expect, it } from 'vitest';
import { pythonPathTokens } from '../../../src/extensions/resolution/python-path-tokens';

describe('pythonPathTokens', () => {
  it('tokenizes a path chain', () => {
    expect(pythonPathTokens('Path(__file__).parents[2] / r"x.py"')).toEqual([
      { kind: 'name', text: 'Path' },
      { kind: 'punct', text: '(' },
      { kind: 'name', text: '__file__' },
      { kind: 'punct', text: ')' },
      { kind: 'punct', text: '.' },
      { kind: 'name', text: 'parents' },
      { kind: 'punct', text: '[' },
      { kind: 'number', text: '2' },
      { kind: 'punct', text: ']' },
      { kind: 'punct', text: '/' },
      { kind: 'string', text: 'x.py' },
    ]);
  });

  it.each([
    ['a string holding a backslash', '"share\\x.py"'],
    ['an f-string', 'f"share/{name}.py"'],
    ['a plain f-string', 'f"x.py"'],
    ['concatenation', '"share/" + name'],
    ['formatting', '"%s.py" % name'],
    ['a bytes literal', 'b"x.py"'],
  ])('refuses %s', (_label, expression) => {
    expect(pythonPathTokens(expression)).toBeNull();
  });
});
