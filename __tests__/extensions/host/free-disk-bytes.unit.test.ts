import { statfsSync, type StatsFs } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freeDiskBytes } from '../../../src/extensions/host/builder/free-disk-bytes';

vi.mock('node:fs', () => ({ statfsSync: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe('freeDiskBytes', () => {
  it('returns the blocks available to this user times the block size', () => {
    const stats: StatsFs = { type: 0, bsize: 4096, blocks: 11, bfree: 7, bavail: 3, files: 0, ffree: 0 };
    vi.mocked(statfsSync).mockReturnValue(stats);
    expect(freeDiskBytes('/volume')).toBe(12288);
    expect(statfsSync).toHaveBeenCalledWith('/volume');
  });

  it('returns null when the file system cannot be asked', () => {
    vi.mocked(statfsSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(freeDiskBytes('/missing')).toBeNull();
  });
});
