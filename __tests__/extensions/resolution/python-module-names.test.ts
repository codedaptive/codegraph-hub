/**
 * Unit tests of pythonModuleNames over hand-written logical lines: a name bound once in
 * module scope (at top level or in an if/try body) is known with its value; one rebound in
 * a module-level block, declared `global` in a function, bound only in a def or class
 * body, or bound other than by `name = value` on one line is not.
 */
import { describe, expect, it } from 'vitest';
import { pythonModuleNames } from '../../../src/extensions/resolution/python-module-names';

const line = (indent: number, text: string) => ({ indent, text });

describe('pythonModuleNames', () => {
  it('knows names bound once in module scope, at column 0 or in a block body', () => {
    expect(pythonModuleNames([
      line(0, 'ROOT = Path(__file__).parent'),
      line(0, 'if True:'),
      line(4, 'SCRIPT = ROOT / "x.py"'),
    ])).toEqual(new Map([['ROOT', 'Path(__file__).parent'], ['SCRIPT', 'ROOT / "x.py"']]));
  });

  it('drops a name rebound in a module-level try, except or for', () => {
    expect(pythonModuleNames([
      line(0, 'A = "a.py"'),
      line(0, 'B = "b.py"'),
      line(0, 'C = "c.py"'),
      line(0, 'try:'),
      line(4, 'A = "other.py"'),
      line(0, 'except ImportError as B:'),
      line(4, 'pass'),
      line(0, 'for C in []:'),
      line(4, 'pass'),
    ])).toEqual(new Map());
  });

  it('ignores def and class bodies, nested ones included, and resumes after them', () => {
    expect(pythonModuleNames([
      line(0, 'ROOT = "r.py"'),
      line(0, 'class C:'),
      line(4, 'ROOT = 1'),
      line(4, 'def m(self):'),
      line(8, 'if x:'),
      line(12, 'ROOT = 2'),
      line(0, 'LATER = "l.py"'),
    ])).toEqual(new Map([['ROOT', '"r.py"'], ['LATER', '"l.py"']]));
  });

  it('drops every name a function declares global', () => {
    expect(pythonModuleNames([
      line(0, 'A = "a.py"'),
      line(0, 'B = "b.py"'),
      line(0, 'C = "c.py"'),
      line(0, 'def reset():'),
      line(4, 'global A, B'),
    ])).toEqual(new Map([['C', '"c.py"']]));
  });

  it('knows no value for an annotated, augmented, tuple or multi-line binding', () => {
    expect(pythonModuleNames([
      line(0, 'A: str = "a.py"'),
      line(0, 'B += "b.py"'),
      line(0, 'C, D = "c.py", "d.py"'),
      line(0, 'E = Path(\n    "e.py")'),
    ])).toEqual(new Map());
  });
});
