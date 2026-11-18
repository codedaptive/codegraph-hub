import { describe, expect, it } from 'vitest';
import { requireWritable } from '../../../src/extensions/host/builder/require-writable';

describe('requireWritable', () => {
  it('lets a job of an open hold that owns writer.pid run', () => {
    expect(() => requireWritable({ root: '/repo', closed: false, owner: true })).not.toThrow();
  });

  it.each([
    ['a closed hold', { root: '/repo', closed: true, owner: true }],
    ['a hold that does not own writer.pid', { root: '/repo', closed: false, owner: false }],
  ])('refuses a job of %s', (_name, hold) => {
    expect(() => requireWritable(hold)).toThrow('/repo was released by the index builder');
  });
});
