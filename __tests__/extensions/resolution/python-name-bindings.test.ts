/**
 * Unit tests of pythonNameBindings: which occurrences of a word count as possible
 * bindings (an `=`, augmented operator or `:` after it, a binding keyword before it on its
 * logical line, a depth-0 `=` after it, a single-line string around it), which are reads,
 * and the dynamic forms that make the whole file null.
 */
import { describe, expect, it } from 'vitest';
import { pythonNameBindings } from '../../../src/extensions/resolution/python-name-bindings';

describe('pythonNameBindings', () => {
  it('maps each word to the line of each possible binding', () => {
    expect(pythonNameBindings('A = 1\nA += 2\nprint(A)')).toEqual(new Map([['A', ['A = 1', 'A += 2']]]));
  });

  it.each([
    ['A = 1', 'assignment'],
    ['A: int', 'annotation'],
    ['A //= 2', 'augmented operator'],
    ['A **= 2', 'augmented power'],
    ['(A := 1)', 'walrus'],
    ['A \\\n  = 1', 'continued assignment'],
    ['x, A = 1, 2', 'tuple target'],
    ['A.b = 1', 'attribute target'],
    ['A[0] += 1', 'augmented subscript'],
    ['def f(A): pass', 'parameter'],
    ['class A: pass', 'class'],
    ['g = lambda A: 0', 'lambda'],
    ['[0 for A in y]', 'comprehension target'],
    ['import m as A', 'alias'],
    ['global A', 'global'],
    ['nonlocal A', 'nonlocal'],
    ['del A', 'del'],
    ['case A: pass', 'case'],
    ['patch("m.A")', 'double-quoted string'],
    ["patch('m.A')", 'single-quoted string'],
  ])('counts A in %s (%s)', (source) => {
    expect(pythonNameBindings(source)?.has('A')).toBe(true);
  });

  it.each([
    ['print(A)', 'call argument'],
    ['x = A', 'assignment value'],
    ['A == 1', 'equality'],
    ['A <= 1', 'comparison'],
    ['A != 1', 'inequality'],
    ['f(A, key=1)', 'keyword inside brackets'],
    ['x = f(A)[0]', 'call after the assignment'],
    ['[A for x in y]', 'comprehension element'],
    ['A.b(c)', 'method call'],
    ['"m" + A', 'beside a string'],
  ])('reads A in %s (%s)', (source) => {
    expect(pythonNameBindings(source)?.has('A')).toBe(false);
  });

  it.each([
    'from m import *',
    'globals()',
    'vars(m)',
    'locals()',
    'exec(code)',
    'eval(code)',
    'setattr(m, "A", 1)',
    'm.__dict__',
    'sys.modules["m"]',
    'sys .modules',
  ])('gives null for a file with %s', (dynamic) => {
    expect(pythonNameBindings(`A = 1\n${dynamic}`)).toBeNull();
  });

  it('does not count words that only contain a dynamic word', () => {
    expect(pythonNameBindings('spec.loader.exec_module(m)\nenv_vars = 1\nevaluate(x)')).toEqual(new Map([['env_vars', ['env_vars = 1']]]));
  });
});
