import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listener: undefined as ((root: string, created: string | null) => void) | undefined,
  runColdBuild: vi.fn(),
}));
vi.mock('../../../src/extensions/host/worktree-lifecycle/cold-build-database', () => ({
  coldBuildDatabases: { onSet: (listener: (root: string, created: string | null) => void) => { mocks.listener = listener; } },
}));
vi.mock('../../../src/extensions/host/worktree-lifecycle/cold-build', () => ({ runColdBuild: mocks.runColdBuild }));

import { coldBuildBody } from '../../../src/extensions/host/builder/cold-build-body';

describe('coldBuildBody', () => {
  it('reports each database the build registers and answers the build exit code', async () => {
    const reportDatabase = vi.fn();
    mocks.runColdBuild.mockImplementation(async (root: string) => {
      mocks.listener?.(root, '7:9');
      return 4;
    });
    expect(await coldBuildBody({ root: '/repo' }, { progress: vi.fn(), reportDatabase, writerPid: 1 })).toBe(4);
    expect(mocks.runColdBuild).toHaveBeenCalledExactlyOnceWith('/repo');
    expect(reportDatabase).toHaveBeenCalledExactlyOnceWith('/repo', '7:9');
  });
});
