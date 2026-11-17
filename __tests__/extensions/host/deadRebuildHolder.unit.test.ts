import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { getCodeGraphDir } from '../../../src/directory';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { deadRebuildHolder } from '../../../src/extensions/host/worktree-lifecycle/deadRebuildHolder';

vi.mock('fs', async (original) => ({ ...await original<typeof import('fs')>() }));
vi.mock('../../../src/directory', () => ({ getCodeGraphDir: vi.fn() }));
vi.mock('../../../src/mcp/writer-lock', () => ({ readWriterLock: vi.fn() }));
vi.mock('../../../src/mcp/server-control', () => ({ isProcessAlive: vi.fn() }));

const root = '/project';

describe('deadRebuildHolder', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCodeGraphDir).mockReturnValue('/fake-index');
    vi.mocked(readWriterLock).mockReturnValue(null);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns false without reading a lock when rebuild.pid is absent', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(deadRebuildHolder(root)).toBe(false);
    expect(fs.existsSync).toHaveBeenCalledWith('/fake-index/rebuild.pid');
    expect(getCodeGraphDir).toHaveBeenCalledWith(root);
    expect(readWriterLock).not.toHaveBeenCalled();
  });

  it('treats an unreadable record in an existing file as dead', () => {
    expect(deadRebuildHolder(root)).toBe(true);
    expect(readWriterLock).toHaveBeenCalledWith(root, 'rebuild.pid');
  });

  it('treats another dead pid as dead', () => {
    const pid = process.pid + 1;
    vi.mocked(readWriterLock).mockReturnValue({ pid, mode: 'rebuild', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(deadRebuildHolder(root)).toBe(true);
    expect(isProcessAlive).toHaveBeenCalledWith(pid);
  });

  it('does not treat another live pid as dead', () => {
    const pid = process.pid + 1;
    vi.mocked(readWriterLock).mockReturnValue({ pid, mode: 'rebuild', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(true);
    expect(deadRebuildHolder(root)).toBe(false);
    expect(isProcessAlive).toHaveBeenCalledWith(pid);
  });

  it('does not treat this process as a dead rebuild holder', () => {
    vi.mocked(readWriterLock).mockReturnValue({ pid: process.pid, mode: 'rebuild', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(deadRebuildHolder(root)).toBe(false);
  });
});
