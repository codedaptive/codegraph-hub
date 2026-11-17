import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freeDiskBytes } from '../../../src/extensions/host/builder/free-disk-bytes';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-free-disk-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('freeDiskBytes', () => {
  it('returns a positive whole byte count for an existing directory', () => {
    const bytes = freeDiskBytes(dir);
    expect(bytes).not.toBeNull();
    expect(bytes).toBeGreaterThan(0);
    expect(Number.isInteger(bytes)).toBe(true);
  });

  it('returns null for a nonexistent path', () => {
    expect(freeDiskBytes(path.join(dir, 'missing'))).toBeNull();
  });
});
