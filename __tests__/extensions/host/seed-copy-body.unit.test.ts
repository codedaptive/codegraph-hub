import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ seedFromSibling: vi.fn(), registerProject: vi.fn() }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/seed', () => ({ seedFromSibling: mocks.seedFromSibling }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/project-registry', () => ({ registerProject: mocks.registerProject }));

import { seedCopyBody } from '../../../src/extensions/host/builder/seed-copy-body';

const args = { root: '/wt', source: '/main', commonDir: '/main/.git' };

describe('seedCopyBody', () => {
  beforeEach(() => vi.resetAllMocks());

  it('copies, registers the root seeded with the nonce, logs the line and answers the method', async () => {
    mocks.seedFromSibling.mockResolvedValue({ method: 'clone', nonce: 'abc' });
    const progress = vi.fn();
    expect(await seedCopyBody(args, { progress })).toBe('clone');
    expect(mocks.seedFromSibling).toHaveBeenCalledExactlyOnceWith('/wt', '/main');
    expect(mocks.registerProject).toHaveBeenCalledExactlyOnceWith('/wt', { seeded: true, commonDir: '/main/.git', seedNonce: 'abc' });
    expect(progress).toHaveBeenCalledExactlyOnceWith({ log: '[CodeGraph MCP] Seeded the index of /wt from /main (clone).' });
  });

  it('registers nothing and logs nothing when the copy fails', async () => {
    mocks.seedFromSibling.mockRejectedValue(Object.assign(new Error('taken'), { name: 'SeedTargetTakenError' }));
    const progress = vi.fn();
    await expect(seedCopyBody(args, { progress })).rejects.toMatchObject({ name: 'SeedTargetTakenError' });
    expect(mocks.registerProject).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
