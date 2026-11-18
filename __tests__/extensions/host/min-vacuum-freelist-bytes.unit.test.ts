import { describe, expect, it } from 'vitest';
import { MIN_VACUUM_FREELIST_BYTES } from '../../../src/extensions/host/builder/min-vacuum-freelist-bytes';

describe('MIN_VACUUM_FREELIST_BYTES', () => {
  it("is R-45's 256 MB floor, read as 256 MiB", () => {
    expect(MIN_VACUUM_FREELIST_BYTES).toBe(268_435_456);
  });
});
