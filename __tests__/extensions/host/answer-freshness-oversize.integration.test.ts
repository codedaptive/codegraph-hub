import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { oversizeStamp } from '../../../src/file-limits';
import { validateAnswerFiles } from '../../../src/mcp/answer-freshness';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

describe('oversize answer freshness', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.clearAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('marks a grown oversize file stale without reading it', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversize-freshness-'));
    const fd = fs.openSync(path.join(root, 'big.bin'), 'w');
    fs.ftruncateSync(fd, 9 * 1024 * 1024);
    fs.closeSync(fd);
    const contentHash = createHash('sha256').update(oversizeStamp(2 * 1024 * 1024)).digest('hex');
    expect(contentHash).toBe('a0f595fead9b5e36eb4811b9018cab73e29341804082e4eceaa6d4091747809e');

    const result = await validateAnswerFiles(root, [{ path: 'big.bin', contentHash }]);

    expect(result).toEqual({ stale: ['big.bin'], unchecked: [] });
    expect(fs.createReadStream).not.toHaveBeenCalled();
  });

  it('keeps an unchanged oversize file current without reading it', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversize-freshness-'));
    const fd = fs.openSync(path.join(root, 'big.bin'), 'w');
    fs.ftruncateSync(fd, 2 * 1024 * 1024);
    fs.closeSync(fd);
    const contentHash = createHash('sha256').update(oversizeStamp(2 * 1024 * 1024)).digest('hex');

    const result = await validateAnswerFiles(root, [{ path: 'big.bin', contentHash }]);

    expect(result).toEqual({ stale: [], unchecked: [] });
    expect(fs.createReadStream).not.toHaveBeenCalled();
  });
});
