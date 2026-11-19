import { describe, expect, it } from 'vitest';
import { isJsonObject } from '../../../src/extensions/host/server/isJsonObject';

describe('isJsonObject', () => {
  it.each([{}, { a: 1 }])('accepts an object: %j', value => {
    expect(isJsonObject(value)).toBe(true);
  });

  it.each([null, [], [1], 5, 'x', true, undefined])('rejects a non-object or array: %j', value => {
    expect(isJsonObject(value)).toBe(false);
  });
});
