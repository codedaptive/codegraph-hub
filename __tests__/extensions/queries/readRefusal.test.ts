import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInitialized } from '../../../src/directory';
import { requireGitWorktreeRoot } from '../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot';
import { readRefusal } from '../../../src/extensions/queries/shared/readRefusal';

vi.mock('../../../src/directory', () => ({ isInitialized: vi.fn() }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot', () => ({
  requireGitWorktreeRoot: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe('readRefusal', () => {
  it('lets an unindexed root through without consulting the worktree check', () => {
    vi.mocked(isInitialized).mockReturnValue(false);
    expect(readRefusal('/example')).toBeNull();
    expect(requireGitWorktreeRoot).not.toHaveBeenCalled();
  });

  it('lets an initialized allowed root through', () => {
    vi.mocked(isInitialized).mockReturnValue(true);
    vi.mocked(requireGitWorktreeRoot).mockReturnValue({ root: '/example' });
    expect(readRefusal('/example')).toBeNull();
    expect(requireGitWorktreeRoot).toHaveBeenCalledWith('/example');
  });

  it('formats the refusal for an initialized disallowed root', () => {
    vi.mocked(isInitialized).mockReturnValue(true);
    vi.mocked(requireGitWorktreeRoot).mockReturnValue({ refusal: 'X refused' });
    expect(readRefusal('/example')).toBe('✗ X refused\n');
    expect(requireGitWorktreeRoot).toHaveBeenCalledWith('/example');
  });
});
