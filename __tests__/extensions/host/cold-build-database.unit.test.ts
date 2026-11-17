import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ statInode: vi.fn(), existsSync: vi.fn() }));
vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => root, statInode: mocks.statInode }));
vi.mock('fs', () => ({ existsSync: mocks.existsSync }));

import { coldBuildDatabases } from '../../../src/extensions/host/worktree-lifecycle/cold-build-database';

const root = '/project';
const file = '/project/.codegraph/codegraph.db';

describe('coldBuildDatabases', () => {
  beforeEach(() => { coldBuildDatabases.clear(root); vi.resetAllMocks(); });
  afterEach(() => { coldBuildDatabases.clear(root); vi.unstubAllGlobals(); });

  it('does not own an unregistered root', () => {
    expect(coldBuildDatabases.isOurs(root, file)).toBe(false);
  });

  it('owns the registered identity until cleared', () => {
    coldBuildDatabases.set(root, '1:2');
    mocks.statInode.mockReturnValue('1:2');
    expect(coldBuildDatabases.isOurs(root, file)).toBe(true);
    coldBuildDatabases.clear(root);
    expect(coldBuildDatabases.isOurs(root, file)).toBe(false);
  });

  it('does not own a replacement file with another identity', () => {
    coldBuildDatabases.set(root, '1:2');
    mocks.statInode.mockReturnValue('1:3');
    expect(coldBuildDatabases.isOurs(root, file)).toBe(false);
  });

  it('does not accept a null identity on POSIX', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    coldBuildDatabases.set(root, null);
    mocks.existsSync.mockReturnValue(true);
    expect(coldBuildDatabases.isOurs(root, file)).toBe(false);
  });

  it('on Windows accepts a present file with null identity but not an absent one', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    coldBuildDatabases.set(root, null);
    mocks.existsSync.mockReturnValue(true);
    expect(coldBuildDatabases.isOurs(root, file)).toBe(true);
    mocks.existsSync.mockReturnValue(false);
    expect(coldBuildDatabases.isOurs(root, file)).toBe(false);
  });
});
