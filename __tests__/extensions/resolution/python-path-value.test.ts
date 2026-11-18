/**
 * Unit tests of PathValue: push normalizes '', '.' and '..' and refuses a climb above an
 * anchored root, join refuses an anchored or unknown part, parent(n) refuses an index past
 * the path's own parents, and joinAll joins left to right.
 */
import { describe, expect, it } from 'vitest';
import { PathValue } from '../../../src/extensions/resolution/python-path-value';

const anchored = new PathValue(true, ['tests', 'unit', 'test_a.py']);
const relative = new PathValue(false, []);

describe('PathValue', () => {
  it('pushes segments, dropping empty and dot segments and popping on ..', () => {
    expect(anchored.push('.././/lib/x.py')).toEqual(new PathValue(true, ['tests', 'unit', 'lib', 'x.py']));
  });

  it('keeps leading .. on a relative path and refuses one above an anchored root', () => {
    expect(relative.push('../../x.py')).toEqual(new PathValue(false, ['..', '..', 'x.py']));
    expect(anchored.push('../../../..')).toBeNull();
  });

  it('joins a relative part and refuses an anchored or unknown one', () => {
    expect(anchored.join(new PathValue(false, ['a', 'b']))).toEqual(new PathValue(true, ['tests', 'unit', 'test_a.py', 'a', 'b']));
    expect(relative.join(anchored)).toBeNull();
    expect(anchored.join(null)).toBeNull();
  });

  it('takes the (n+1)-th parent and refuses one past the root', () => {
    expect(anchored.parent(0)).toEqual(new PathValue(true, ['tests', 'unit']));
    expect(anchored.parent(2)).toEqual(new PathValue(true, []));
    expect(anchored.parent(3)).toBeNull();
  });

  it('joins all parts left to right, and gives null for none or an anchored later part', () => {
    expect(PathValue.joinAll([new PathValue(false, ['a']), new PathValue(false, ['b']), new PathValue(false, ['c'])]))
      .toEqual(new PathValue(false, ['a', 'b', 'c']));
    expect(PathValue.joinAll([])).toBeNull();
    expect(PathValue.joinAll([relative, anchored])).toBeNull();
  });
});
