import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findNearestCodeGraphRoot } from '../../../src/directory';
import { requireGitWorktreeRoot } from '../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot';
import { resolveSuspectsRoot } from '../../../src/extensions/resolution/resolve-suspects-root';

vi.mock('../../../src/directory', () => ({ findNearestCodeGraphRoot: vi.fn() }));
vi.mock('../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot', () => ({ requireGitWorktreeRoot: vi.fn() }));

beforeEach(() => {
  vi.mocked(findNearestCodeGraphRoot).mockReset();
  vi.mocked(requireGitWorktreeRoot).mockReset();
});

describe('resolveSuspectsRoot', () => {
  it('returns the no-index error without checking worktree eligibility', () => {
    vi.mocked(findNearestCodeGraphRoot).mockReturnValue(null);

    expect(resolveSuspectsRoot('/some/path')).toEqual({
      error: 'No CodeGraph index at or above /some/path. Run `codegraph init` in the project first.',
    });
    expect(findNearestCodeGraphRoot).toHaveBeenCalledWith('/some/path');
    expect(requireGitWorktreeRoot).not.toHaveBeenCalled();
  });

  it('checks the found stray index root and returns its refusal', () => {
    vi.mocked(findNearestCodeGraphRoot).mockReturnValue('/stray');
    vi.mocked(requireGitWorktreeRoot).mockReturnValue({ refusal: '/stray is not an allowed index root' });

    expect(resolveSuspectsRoot('/stray/sub')).toEqual({ error: '/stray is not an allowed index root' });
    expect(findNearestCodeGraphRoot).toHaveBeenCalledWith('/stray/sub');
    expect(requireGitWorktreeRoot).toHaveBeenCalledWith('/stray');
  });

  it('returns the found index root rather than the worktree root', () => {
    vi.mocked(findNearestCodeGraphRoot).mockReturnValue('/repo');
    vi.mocked(requireGitWorktreeRoot).mockReturnValue({ root: '/different-worktree-root' });

    expect(resolveSuspectsRoot('/repo/pkg')).toEqual({ root: '/repo' });
    expect(findNearestCodeGraphRoot).toHaveBeenCalledWith('/repo/pkg');
    expect(requireGitWorktreeRoot).toHaveBeenCalledWith('/repo');
  });
});
