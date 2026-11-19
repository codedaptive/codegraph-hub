/**
 * Unit tests of pythonSkipToken: one step past a character, a whole string (escaped
 * quote kept inside; an unterminated one stops at its newline), or a whole bracketed
 * group with the strings and groups nested in it (past the end when it never closes).
 */
import { describe, expect, it } from 'vitest';
import { pythonSkipToken } from '../../../src/extensions/resolution/python-skip-token';

describe('pythonSkipToken', () => {
  it.each([
    ['one character', 'abc', 1],
    ['a whole string', '"a,b" x', 5],
    ['a string with an escaped quote', '"a\\"b" z', 6],
    ['an unterminated string, up to its newline', '"ab\ncd', 3],
    ['a group with a nested group and a string holding ")"', '(a, (b), "c)") y', 14],
    ['a group that never closes', '(a, b', 6],
  ])('steps over %s', (_label, source, expected) => {
    expect(pythonSkipToken(source, 0)).toBe(expected);
  });
});
