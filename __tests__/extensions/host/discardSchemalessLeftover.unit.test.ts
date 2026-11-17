import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { getCodeGraphDir, hasSchemalessDb } from '../../../src/directory';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { isProcessAlive } from '../../../src/mcp/server-control';
import { discardSchemalessLeftover } from '../../../src/extensions/host/worktree-lifecycle/discardSchemalessLeftover';

vi.mock('fs', async (original) => ({ ...await original<typeof import('fs')>() }));
vi.mock('../../../src/directory', () => ({ getCodeGraphDir: vi.fn(), hasSchemalessDb: vi.fn() }));
vi.mock('../../../src/mcp/writer-lock', () => ({ readWriterLock: vi.fn() }));
vi.mock('../../../src/mcp/server-control', () => ({ isProcessAlive: vi.fn() }));

const root = '/project';
const files = [
  '/fake-index/codegraph.db',
  '/fake-index/codegraph.db-wal',
  '/fake-index/codegraph.db-shm',
  '/fake-index/codegraph.db-journal',
];

describe('discardSchemalessLeftover', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCodeGraphDir).mockReturnValue('/fake-index');
    vi.mocked(readWriterLock).mockReturnValue(null);
    vi.mocked(hasSchemalessDb).mockReturnValue(true);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => vi.restoreAllMocks());

  it('does nothing without a dead holder and does not inspect the root', () => {
    expect(discardSchemalessLeftover(root, false)).toBe(false);
    expect(readWriterLock).not.toHaveBeenCalled();
    expect(hasSchemalessDb).not.toHaveBeenCalled();
    expect(getCodeGraphDir).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('keeps the database while another live writer holds it', () => {
    const pid = process.pid + 1;
    vi.mocked(readWriterLock).mockReturnValue({ pid, mode: 'builder', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(true);
    expect(discardSchemalessLeftover(root, true)).toBe(false);
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('removes a schemaless database when the writer is this process', () => {
    vi.mocked(readWriterLock).mockReturnValue({ pid: process.pid, mode: 'builder', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(true);
    expect(discardSchemalessLeftover(root, true)).toBe(true);
    expect(vi.mocked(fs.rmSync).mock.calls.map(([file]) => file)).toEqual(files);
  });

  it('removes exactly the database and three siblings after a dead writer', () => {
    vi.mocked(readWriterLock).mockReturnValue({ pid: process.pid + 1, mode: 'builder', startedAt: 1 });
    vi.mocked(isProcessAlive).mockReturnValue(false);
    expect(discardSchemalessLeftover(root, true)).toBe(true);
    expect(vi.mocked(fs.rmSync).mock.calls.map(([file]) => file)).toEqual(files);
  });

  it('keeps a database that is not schemaless', () => {
    vi.mocked(hasSchemalessDb).mockReturnValue(false);
    expect(discardSchemalessLeftover(root, true)).toBe(false);
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('tries every sibling and returns true if one removal throws', () => {
    vi.mocked(fs.rmSync).mockImplementation((file) => {
      if (file === '/fake-index/codegraph.db-wal') throw new Error('removal failed');
    });
    expect(discardSchemalessLeftover(root, true)).toBe(true);
    expect(vi.mocked(fs.rmSync).mock.calls.map(([file]) => file)).toEqual(files);
  });
});
