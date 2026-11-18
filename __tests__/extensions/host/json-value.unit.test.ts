/** jsonValue (src/extensions/host/builder/json-value.ts): a value as JSON carries it. */
import { describe, expect, it } from 'vitest';
import { jsonValue } from '../../../src/extensions/host/builder/json-value';

describe('jsonValue', () => {
  it('drops undefined properties at every depth and keeps the rest', () => {
    const value = { a: 1, b: undefined, nested: { c: 'x', d: undefined }, list: [{ e: true, f: undefined }] };
    expect(Object.keys(jsonValue(value))).toEqual(['a', 'nested', 'list']);
    expect(jsonValue(value)).toStrictEqual({ a: 1, nested: { c: 'x' }, list: [{ e: true }] });
  });

  it('gives back a JSON value unchanged', () => {
    for (const value of [null, 0, 'text', [1, 'two', null], { k: [{ v: false }] }]) {
      expect(jsonValue(value)).toStrictEqual(value);
    }
  });
});
