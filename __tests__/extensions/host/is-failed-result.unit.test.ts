import { describe, expect, it } from 'vitest';
import { isFailedResult } from '../../../src/extensions/host/builder/is-failed-result';

describe('isFailedResult', () => {
  it.each([
    ['an object with success false', { success: false }, true],
    ['an object with success true', { success: true }, false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['an empty object', {}, false],
    ['a string', 'failure', false],
    ['a number', 0, false],
    ['an object with success string false', { success: 'false' }, false],
    ['an object with success zero', { success: 0 }, false],
  ])('classifies %s', (_name, value, expected) => {
    expect(isFailedResult(value)).toBe(expected);
  });
});
