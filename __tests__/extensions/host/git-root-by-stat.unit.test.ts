import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'fs';
import { gitRootByStat } from '../../../src/extensions/host/server/index-root';

const paths = vi.hoisted(() => new Set<string>());

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  existsSync: (p: PathLike) => paths.has(String(p)),
}));

vi.mock('../../../src/extensions/host/worktree-lifecycle/git', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/extensions/host/worktree-lifecycle/git')>(),
  canonicalGitPath: (p: string) => p,
}));

describe('gitRootByStat', () => {
  beforeEach(() => paths.clear());

  it('finds the main worktree root', () => {
    paths.add('/w/repo');
    paths.add('/w/repo/.git');
    expect(gitRootByStat('/w/repo')).toBe('/w/repo');
  });

  it('finds a linked worktree root when .git is a file', () => {
    paths.add('/w/linked');
    paths.add('/w/linked/.git');
    expect(gitRootByStat('/w/linked')).toBe('/w/linked');
  });

  it('finds the nearest enclosing worktree from a subfolder', () => {
    paths.add('/w/repo/src/deep');
    paths.add('/w/repo/.git');
    paths.add('/w/.git');
    expect(gitRootByStat('/w/repo/src/deep')).toBe('/w/repo');
  });

  it('returns null for a plain folder', () => {
    paths.add('/w/plain');
    expect(gitRootByStat('/w/plain')).toBeNull();
  });
});
