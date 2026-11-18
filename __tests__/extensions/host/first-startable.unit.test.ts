import { describe, expect, it } from 'vitest';
import { firstStartable } from '../../../src/extensions/host/builder/first-startable';

describe('firstStartable', () => {
  it('returns -1 for an empty queue', () => {
    expect(firstStartable([], new Set())).toBe(-1);
  });

  it('returns -1 when every entry intersects busy roots', () => {
    expect(firstStartable([{ rootKeys: ['a'] }, { rootKeys: ['b', 'c'] }], new Set(['a', 'c']))).toBe(-1);
  });

  it('skips a busy head and selects the second entry', () => {
    expect(firstStartable([{ rootKeys: ['a'] }, { rootKeys: ['b'] }], new Set(['a']))).toBe(1);
  });

  it('treats an additional root as a conflict', () => {
    expect(firstStartable([{ rootKeys: ['a', 'source'] }, { rootKeys: ['b'] }], new Set(['source']))).toBe(1);
  });

  it('returns the first disjoint entry across generated root combinations', () => {
    const roots = ['a', 'b', 'c'];
    for (let busyMask = 0; busyMask < 8; busyMask++) {
      const busy = new Set(roots.filter((_, i) => (busyMask & (1 << i)) !== 0));
      for (let masks = 0; masks < 512; masks++) {
        const entries = [0, 1, 2].map((i) => ({
          rootKeys: roots.filter((_, j) => (masks & (1 << (i * 3 + j))) !== 0),
        }));
        const chosen = firstStartable(entries, busy);
        if (chosen === -1) {
          expect(entries.every((entry) => entry.rootKeys.some((root) => busy.has(root)))).toBe(true);
        } else {
          expect(chosen).toBeGreaterThanOrEqual(0);
          expect(chosen).toBeLessThan(entries.length);
          expect(entries[chosen].rootKeys.every((root) => !busy.has(root))).toBe(true);
          expect(entries.slice(0, chosen).every((entry) => entry.rootKeys.some((root) => busy.has(root)))).toBe(true);
        }
      }
    }
  });
});
