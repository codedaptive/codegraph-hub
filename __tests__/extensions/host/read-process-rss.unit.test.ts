import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProcessRssBytes } from '../../../src/extensions/host/builder/read-process-rss';

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], _options: { timeout: number },
    _callback: (error: Error | null, stdout: string) => void) => {}),
}));
vi.mock('child_process', () => ({ execFile }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  execFile.mockReset();
});

afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
});

describe('readProcessRssBytes ps path', () => {
  it('returns null when ps times out with empty stdout', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error('timed out'), ''));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });

  it('limits the ps call to 5000 milliseconds', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '2048'));
    await readProcessRssBytes(123);
    expect(execFile).toHaveBeenCalledWith('ps', ['-o', 'rss=', '-p', '123'], { timeout: 5000 }, expect.any(Function));
  });

  it('converts whitespace-padded ps KiB output to bytes', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '  2048\n'));
    await expect(readProcessRssBytes(123)).resolves.toBe(2097152);
  });
});
