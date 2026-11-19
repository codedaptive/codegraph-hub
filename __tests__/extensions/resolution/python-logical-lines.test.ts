/**
 * Unit tests of pythonLogicalLines: lines split at depth-0 newlines, joined across open
 * brackets and '\' continuations, trimmed, blank ones dropped, and an unclosed bracket
 * running to the end.
 */
import { describe, expect, it } from 'vitest';
import { pythonLogicalLines } from '../../../src/extensions/resolution/python-logical-lines';

describe('pythonLogicalLines', () => {
  it('splits at newlines, trims, and drops blank lines', () => {
    expect(pythonLogicalLines('a = 1\n\n    b = 2  \n   \nc')).toEqual(['a = 1', 'b = 2', 'c']);
  });

  it('joins lines inside brackets and after a backslash', () => {
    expect(pythonLogicalLines('f(\n  x,\n  [y,\n   z])\ng = 1 + \\\n  2\nh')).toEqual(['f(\n  x,\n  [y,\n   z])', 'g = 1 + \\\n  2', 'h']);
  });

  it('does not open a bracket inside a string', () => {
    expect(pythonLogicalLines('a = "("\nb = \')\'\nc = 3')).toEqual(['a = "("', "b = ')'", 'c = 3']);
  });

  it('runs an unclosed bracket and a trailing backslash to the end', () => {
    expect(pythonLogicalLines('a = 1\nb = f(\n  2')).toEqual(['a = 1', 'b = f(\n  2']);
    expect(pythonLogicalLines('a = 1\nb = \\')).toEqual(['a = 1', 'b = \\']);
  });
});
