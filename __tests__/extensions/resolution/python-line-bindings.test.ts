/**
 * Unit tests of pythonLineBindings: the names a logical line binds (plain, annotated,
 * augmented and tuple assignment targets, `for` and `as` targets, def and class names),
 * and the lines that bind no name (attribute and subscript targets, keyword arguments,
 * comparisons, statements without a target).
 */
import { describe, expect, it } from 'vitest';
import { pythonLineBindings } from '../../../src/extensions/resolution/python-line-bindings';

describe('pythonLineBindings', () => {
  it.each([
    ['ROOT = Path(__file__)', ['ROOT']],
    ['ROOT: str = "x"', ['ROOT']],
    ['ROOT += "x"', ['ROOT']],
    ['a, *b = 1, 2', ['a', 'b']],
    ['(a, b) = pair', ['a', 'b']],
    ['for k, v in items:', ['k', 'v']],
    ['with open(p) as f, ctx() as (g, h):', ['f', 'g', 'h']],
    ['def load(path):', ['load']],
    ['async def run():', ['run']],
    ['class C(Base):', ['C']],
  ])('binds the names of %s', (text, expected) => {
    expect(pythonLineBindings(text)).toEqual(expected);
  });

  it.each([
    'self.x = 1',
    'd[k] = v',
    'configure(path="s.py")',
    'x == 1',
    'x <= 1',
    'return x',
  ])('binds no name in %s', (text) => {
    expect(pythonLineBindings(text)).toEqual([]);
  });
});
