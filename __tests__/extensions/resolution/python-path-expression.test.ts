/**
 * Unit tests of pythonPathExpression, the pure evaluator of one Python path expression:
 * a `__file__`-anchored chain comes back root-relative with a leading '/', a literal
 * relative as written (with './' when it has no '/'), a module name is read from the
 * names map, and a name cycle, a climb above the root or a computed value gives null.
 */
import { describe, expect, it } from 'vitest';
import { pythonPathExpression } from '../../../src/extensions/resolution/python-path-expression';

const file = 'tests/unit/test_a.py';
const none = new Map<string, string>();

describe('pythonPathExpression', () => {
  it('evaluates an anchored chain to a root-relative path', () => {
    expect(pythonPathExpression('Path(__file__).resolve().parents[1] / "lib" / "x.py"', file, none)).toBe('/tests/lib/x.py');
    expect(pythonPathExpression('os.path.join(os.path.dirname(__file__), "..", "x.py")', file, none)).toBe('/tests/x.py');
  });

  it('keeps a literal relative, normalized, with ./ when it has no slash', () => {
    expect(pythonPathExpression('"share/./x.py"', file, none)).toBe('share/x.py');
    expect(pythonPathExpression("'x.py'", file, none)).toBe('./x.py');
    expect(pythonPathExpression('"../lib/x.py"', file, none)).toBe('../lib/x.py');
  });

  it('reads a module name from the names map, recursively', () => {
    const names = new Map([['ROOT', 'Path(__file__).parent'], ['SCRIPT', 'ROOT / "share"']]);
    expect(pythonPathExpression('SCRIPT / "x.py"', file, names)).toBe('/tests/unit/share/x.py');
  });

  it('gives null for a two-name cycle', () => {
    const names = new Map([['A', 'B'], ['B', 'A']]);
    expect(pythonPathExpression('A / "x.py"', file, names)).toBeNull();
  });

  it('gives null for a path that climbs above the root', () => {
    expect(pythonPathExpression('Path(__file__).parents[3] / "x.py"', file, none)).toBeNull();
    expect(pythonPathExpression('os.path.join(os.path.dirname(__file__), "..", "..", "..", "x.py")', file, none)).toBeNull();
  });

  it('gives null for an absolute literal, an unknown name and a computed value', () => {
    expect(pythonPathExpression('"/abs/x.py"', file, none)).toBeNull();
    expect(pythonPathExpression('p', file, none)).toBeNull();
    expect(pythonPathExpression('sys.argv[1]', file, none)).toBeNull();
  });
});
