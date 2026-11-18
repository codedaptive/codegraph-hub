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
    expect(execFile).toHaveBeenCalledWith('ps', ['-o', 'rss=', '-p', '123'], { timeout: 5000, windowsHide: true }, expect.any(Function));
  });

  it('converts whitespace-padded ps KiB output to bytes', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '  2048\n'));
    await expect(readProcessRssBytes(123)).resolves.toBe(2097152);
  });
});

describe('readProcessRssBytes Windows path', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  it('calls tasklist with the PID filter, CSV format, timeout, and hidden window', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null, ''));
    await readProcessRssBytes(123);
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      'tasklist', ['/FI', 'PID eq 123', '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true }, expect.any(Function),
    );
  });

  it('converts comma-separated tasklist KiB to bytes', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, '"node.exe","123","Console","1","45,678 K"\r\n'));
    await expect(readProcessRssBytes(123)).resolves.toBe(46774272);
  });

  it('converts period-separated tasklist KiB to bytes', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, '"node.exe","123","Console","1","45.678 K"'));
    await expect(readProcessRssBytes(123)).resolves.toBe(46774272);
  });

  it('returns null when tasklist reports no matching tasks', async () => {
    execFile.mockImplementation((file, _args, _options, callback) => callback(null,
      file === 'tasklist' ? 'INFO: No tasks are running which match the specified criteria.' : '2048'));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });

  it('returns null when tasklist errors', async () => {
    execFile.mockImplementation((file, _args, _options, callback) =>
      file === 'tasklist' ? callback(new Error('tasklist failed'), '') : callback(null, '2048'));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });

  it('returns null when tasklist times out', async () => {
    execFile.mockImplementation((file, _args, _options, callback) =>
      file === 'tasklist' ? callback(new Error('timed out'), '') : callback(null, '2048'));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });

  it('returns null when the tasklist row belongs to another PID', async () => {
    execFile.mockImplementation((file, _args, _options, callback) => callback(null,
      file === 'tasklist' ? '"node.exe","999","Console","1","45,678 K"' : '2048'));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });

  it('returns null when tasklist memory usage has no digits', async () => {
    execFile.mockImplementation((file, _args, _options, callback) => callback(null,
      file === 'tasklist' ? '"node.exe","123","Console","1","N/A"' : '2048'));
    await expect(readProcessRssBytes(123)).resolves.toBeNull();
  });
});
