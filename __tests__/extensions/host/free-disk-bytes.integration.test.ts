import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freeDiskBytes } from '../../../src/extensions/host/builder/free-disk-bytes';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-free-disk-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('freeDiskBytes', () => {
  it('returns the blocks available to this user times the block size', () => {
    const bytes = freeDiskBytes(dir);
    const fsStats = fs.statfsSync(dir);
    // Any writer on the volume moves bavail between the two reads, so allow 1 GiB of drift: that still fails
    // the wrong answers (bsize alone, or bavail alone, a block count).
    expect(bytes).toBeGreaterThan(0);
    expect(Math.abs((bytes ?? 0) - fsStats.bavail * fsStats.bsize)).toBeLessThan(1024 ** 3);
  });

  it('returns null for a nonexistent path', () => {
    expect(freeDiskBytes(path.join(dir, 'missing'))).toBeNull();
  });
});
