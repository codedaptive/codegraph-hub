import { describe, expect, it } from 'vitest';
import { MIN_VACUUM_FREELIST_BYTES } from '../../../src/extensions/host/builder/min-vacuum-freelist-bytes';
import { vacuumVerdict } from '../../../src/extensions/host/builder/vacuum-verdict';

const stats = (pageCount: number, freelistCount: number) => ({ pageSize: 4096, pageCount, freelistCount });

describe('vacuumVerdict', () => {
  it('rejects exactly one quarter even at the minimum', () => {
    expect(vacuumVerdict(stats(262144, 65536), 3_000_000_000)).toBe('freelist-small');
  });
  it('accepts one page over a quarter with enough free space', () => {
    expect(vacuumVerdict(stats(262144, 65537), 3_000_000_000)).toBe('vacuum');
  });
  it('rejects one page below 256 MiB even over a quarter', () => {
    expect(vacuumVerdict(stats(200000, 65535), 3_000_000_000)).toBe('freelist-small');
  });
  it('accepts exactly 256 MiB over a quarter', () => {
    expect(vacuumVerdict(stats(200000, 65536), 3_000_000_000, MIN_VACUUM_FREELIST_BYTES)).toBe('vacuum');
  });
  it('rejects disk exactly twice the database size', () => {
    expect(vacuumVerdict(stats(200000, 65536), 1_638_400_000)).toBe('disk-short');
  });
  it('accepts disk one byte above twice the database size', () => {
    expect(vacuumVerdict(stats(200000, 65536), 1_638_400_001)).toBe('vacuum');
  });
  it('treats unavailable disk statistics as short', () => {
    expect(vacuumVerdict(stats(200000, 65536), null)).toBe('disk-short');
  });
  it('checks the freelist before the disk', () => {
    expect(vacuumVerdict(stats(200000, 1), null)).toBe('freelist-small');
  });
});

