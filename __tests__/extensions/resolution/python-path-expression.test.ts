/**
 * Unit tests of pythonPathExpression, the pure evaluator of one Python path expression:
 * a `__file__`-anchored chain comes back root-relative with a leading '/', a literal
 * relative as written (with './' when it has no '/'), a module name is read from the
 * names map, and a name cycle, an out-of-range parents index, a climb above the root
 * or a computed value gives null; untrusted dotted callees are rejected. Unless a case says
 * otherwise, its file imports Path from pathlib and os, and leaves `__file__` alone.
 */
import { describe, expect, it } from 'vitest';
import { pythonPathExpression } from '../../../src/extensions/resolution/python-path-expression';
import type { PathTrust } from '../../../src/extensions/resolution/python-path-trust';

const file = 'tests/unit/test_a.py';
const none = new Map<string, string>();
const trusted: PathTrust = { file: true, names: new Set(['Path', 'os']) };

describe('pythonPathExpression', () => {
  it('evaluates an anchored chain to a root-relative path', () => {
    expect(pythonPathExpression('Path(__file__).resolve().parents[1] / "lib" / "x.py"', file, none, trusted)).toBe('/tests/lib/x.py');
    expect(pythonPathExpression('os.path.join(os.path.dirname(__file__), "..", "x.py")', file, none, trusted)).toBe('/tests/x.py');
  });

  it('rejects join on an untrusted dotted prefix', () => {
    expect(pythonPathExpression('x.join(os.path.dirname(__file__), "x.py")', file, none, trusted)).toBeNull();
  });

  it('gives null for __file__ the file may rebind', () => {
    expect(pythonPathExpression('Path(__file__).parent / "x.py"', file, none, { file: false, names: new Set(['Path']) })).toBeNull();
  });

  it('gives null for a bare callee the file does not import from a path module', () => {
    expect(pythonPathExpression('Path(__file__).parent / "x.py"', file, none, { file: true, names: new Set(['os']) })).toBeNull();
    expect(pythonPathExpression('str("x.py")', file, none, { file: true, names: new Set() })).toBeNull();
    expect(pythonPathExpression('str("x.py")', file, none, { file: true, names: new Set(['str']) })).toBe('./x.py');
  });

  it('gives null for a dotted callee whose module is untrusted or not a path module', () => {
    expect(pythonPathExpression('os.path.dirname(__file__)', file, none, { file: true, names: new Set(['Path']) })).toBeNull();
    expect(pythonPathExpression('mylib.dirname(__file__)', file, none, { file: true, names: new Set(['mylib']) })).toBeNull();
    expect(pythonPathExpression('pathlib.Path(__file__).parent', file, none, { file: true, names: new Set(['pathlib']) })).toBe('/tests/unit');
  });

  it('keeps a literal relative, normalized, with ./ when it has no slash', () => {
    expect(pythonPathExpression('"share/./x.py"', file, none, trusted)).toBe('share/x.py');
    expect(pythonPathExpression("'x.py'", file, none, trusted)).toBe('./x.py');
    expect(pythonPathExpression('"../lib/x.py"', file, none, trusted)).toBe('../lib/x.py');
  });

  it('reads a module name from the names map, recursively', () => {
    const names = new Map([['ROOT', 'Path(__file__).parent'], ['SCRIPT', 'ROOT / "share"']]);
    expect(pythonPathExpression('SCRIPT / "x.py"', file, names, trusted)).toBe('/tests/unit/share/x.py');
  });

  it('gives null for a two-name cycle', () => {
    const names = new Map([['A', 'B'], ['B', 'A']]);
    expect(pythonPathExpression('A / "x.py"', file, names, trusted)).toBeNull();
  });

  it('rejects a huge parents index without throwing', () => {
    let v: string | null | undefined;
    expect(() => {
      v = pythonPathExpression('Path(__file__).parents[5000000000] / "x.py"', file, none, trusted);
    }).not.toThrow();
    expect(v).toBeNull();
  });

  it('permits the last parent and rejects the next index', () => {
    expect(pythonPathExpression('Path(__file__).parents[2] / "x.py"', file, none, trusted)).toBe('/x.py');
    expect(pythonPathExpression('Path(__file__).parents[3] / "x.py"', file, none, trusted)).toBeNull();
  });

  it('gives null for a path that climbs above the root', () => {
    expect(pythonPathExpression('Path(__file__).parents[3] / "x.py"', file, none, trusted)).toBeNull();
    expect(pythonPathExpression('os.path.join(os.path.dirname(__file__), "..", "..", "..", "x.py")', file, none, trusted)).toBeNull();
  });

  it('gives null for an absolute literal, an unknown name and a computed value', () => {
    expect(pythonPathExpression('"/abs/x.py"', file, none, trusted)).toBeNull();
    expect(pythonPathExpression('p', file, none, trusted)).toBeNull();
    expect(pythonPathExpression('sys.argv[1]', file, none, trusted)).toBeNull();
  });
});
