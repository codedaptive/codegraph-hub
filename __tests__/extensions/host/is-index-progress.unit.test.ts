import { describe, expect, it } from 'vitest';
import { isIndexProgress } from '../../../src/extensions/host/builder/is-index-progress';

describe('isIndexProgress', () => {
  it.each(['scanning', 'parsing', 'storing', 'resolving', 'linking'])('accepts the engine phase %s', (phase) => {
    expect(isIndexProgress({ phase, current: 1, total: 2 })).toBe(true);
  });

  it('accepts a progress naming its current file', () => {
    expect(isIndexProgress({ phase: 'parsing', current: 0, total: 3, currentFile: 'a.ts' })).toBe(true);
  });

  it.each([
    ['a log payload', { log: '[worker] started' }],
    ['an unknown phase', { phase: 'vacuuming', current: 1, total: 2 }],
    ['a missing total', { phase: 'parsing', current: 1 }],
    ['a string count', { phase: 'parsing', current: '1', total: 2 }],
    ['null', null],
    ['a string', 'parsing'],
  ])('rejects %s', (_name, payload) => {
    expect(isIndexProgress(payload)).toBe(false);
  });
});
