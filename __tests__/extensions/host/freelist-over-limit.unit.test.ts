import { describe, expect, it } from 'vitest';
import { freelistOverLimit } from '../../../src/extensions/host/builder/freelist-over-limit';
import { MIN_VACUUM_FREELIST_BYTES } from '../../../src/extensions/host/builder/min-vacuum-freelist-bytes';

const stats = (pageCount: number, freelistCount: number) => ({ pageSize: 4096, pageCount, freelistCount });

describe('freelistOverLimit', () => {
  it('exports the 256 MiB default and honors both boundaries', () => {
    expect(MIN_VACUUM_FREELIST_BYTES).toBe(268_435_456);
    expect(freelistOverLimit(stats(262144, 65536))).toBe(false);
    expect(freelistOverLimit(stats(200000, 65536))).toBe(true);
  });
  it('allows an explicit smaller byte minimum', () => {
    expect(freelistOverLimit(stats(100, 26), 106496)).toBe(true);
    expect(freelistOverLimit(stats(100, 26), 106497)).toBe(false);
  });
});
