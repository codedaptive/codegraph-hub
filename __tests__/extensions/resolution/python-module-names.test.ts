/**
 * Unit tests of pythonModuleNames, over the possible bindings pythonNameBindings reads from
 * hand-written source: a name is known with its value only when its one possible binding
 * is a one-line `NAME = value` at any indent; any other possible binding of it makes it
 * unknown; a dynamic file knows no name.
 */
import { describe, expect, it } from 'vitest';
import { pythonModuleNames } from '../../../src/extensions/resolution/python-module-names';
import { pythonNameBindings } from '../../../src/extensions/resolution/python-name-bindings';

const namesOf = (source: string) => pythonModuleNames(pythonNameBindings(source));

describe('pythonModuleNames', () => {
  it('knows a name bound once, at any indent, with the value trimmed', () => {
    expect(namesOf('ROOT = Path(__file__).parent  \nif True:\n    SCRIPT=ROOT / "x.py"\nprint(SCRIPT)'))
      .toEqual(new Map([['ROOT', 'Path(__file__).parent'], ['SCRIPT', 'ROOT / "x.py"']]));
  });

  it('knows no value spread over two physical lines', () => {
    expect(namesOf('E = Path(\n    "e.py")\nF = "f.py" \\\n    + "g"')).toEqual(new Map());
  });

  it('drops a name with two binding lines, even at different indents', () => {
    expect(namesOf('A = "a.py"\nclass C:\n    A = 1\nB = "b.py"')).toEqual(new Map([['B', '"b.py"']]));
  });

  it.each([
    ['annotation', 'A: str = "a.py"'],
    ['augmented assignment', 'A = "a.py"\nA += "b"'],
    ['tuple target', 'A, B = "a.py", "b.py"'],
    ['later tuple target', 'A = "a.py"\nB, A = 1, 2'],
    ['subscript target', 'A = "a.py"\nA[0] = 1'],
    ['walrus', 'A = "a.py"\nif (A := 1): pass'],
    ['one-line if body', 'A = "a.py"\nif X: A = 1'],
    ['semicolon statement', 'A = "a.py"\nx = 1; A = 2'],
    ['chained assignment', 'A = "a.py"\nB = A = 2'],
    ['parameter', 'A = "a.py"\ndef f(A): pass'],
    ['multi-line parameter', 'A = "a.py"\ndef f(\n    A,\n): pass'],
    ['lambda parameter', 'A = "a.py"\ng = lambda A: A'],
    ['for target', 'A = "a.py"\nfor A in []: pass'],
    ['as target', 'A = "a.py"\nwith c() as A: pass'],
    ['import', 'A = "a.py"\nimport A'],
    ['from import', 'A = "a.py"\nfrom m import A'],
    ['global declaration', 'A = "a.py"\ndef f():\n    global A'],
    ['nonlocal declaration', 'A = "a.py"\ndef f():\n    nonlocal A'],
    ['del', 'A = "a.py"\ndel A'],
    ['case pattern', 'A = "a.py"\nmatch x:\n    case A: pass'],
    ['string mention', 'A = "a.py"\npatch("m.A")'],
  ])('drops a name after a possible %s binding', (_form, source) => {
    expect(namesOf(source).has('A')).toBe(false);
  });

  it('keeps a name whose other occurrences are reads', () => {
    expect(namesOf('A = "a.py"\nprint(A == 1, A <= 2, A != 3)\nB = f(A, key=1)\nC = [A for x in y]\nload(A)'))
      .toEqual(new Map([['A', '"a.py"'], ['B', 'f(A, key=1)'], ['C', '[A for x in y]']]));
  });

  it.each([
    'from m import *',
    'globals()["X"] = 1',
    'vars()',
    'locals()',
    'exec("X = 1")',
    'eval("X")',
    'setattr(mod, "X", 1)',
    'mod.__dict__["X"] = 1',
    'sys.modules[__name__].X = 1',
  ])('knows no name in a file with %s', (dynamic) => {
    expect(namesOf(`A = "a.py"\n${dynamic}`)).toEqual(new Map());
  });

  it('still knows names beside spec.loader.exec_module', () => {
    expect(namesOf('A = "a.py"\nspec.loader.exec_module(module)')).toEqual(new Map([['A', '"a.py"']]));
  });
});
