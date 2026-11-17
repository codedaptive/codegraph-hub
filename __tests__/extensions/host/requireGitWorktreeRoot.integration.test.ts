// Integration, not a ZUT: these tests run real git subprocesses on a throwaway repository (Orc #3349).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import { gitRootByStat } from '../../../src/extensions/host/server/index-root';
import { notARepositoryAnswer } from '../../../src/extensions/host/server/notARepository';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { requireGitWorktreeRoot } from '../../../src/extensions/host/worktree-lifecycle/requireGitWorktreeRoot';

describe('requireGitWorktreeRoot', () => {
  let workspace: string;
  let repo: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync('/tmp/cg-required-git-root-'));
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(workspace, 'state'));
    repo = path.join(workspace, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns the root when given a worktree root', () => {
    expect(requireGitWorktreeRoot(repo)).toEqual({ root: repo });
  });

  it('returns the enclosing worktree root when given a subfolder', () => {
    const sub = path.join(repo, 'src', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    expect(requireGitWorktreeRoot(sub)).toEqual({ root: repo });
  });

  it('returns the linked worktree root when its .git entry is a file', () => {
    fs.writeFileSync(path.join(repo, 'file.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'file.ts'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    const linked = path.join(workspace, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked-test', linked], { cwd: repo, stdio: 'ignore' });
    const sub = path.join(linked, 'sub');
    fs.mkdirSync(sub);

    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true);
    expect(requireGitWorktreeRoot(sub)).toEqual({ root: linked });
  });

  it('uses the real worktree root for a symlinked subfolder', () => {
    const sub = path.join(repo, 'src');
    const link = path.join(workspace, 'alias');
    fs.mkdirSync(sub);
    fs.symlinkSync(sub, link);
    expect(requireGitWorktreeRoot(link)).toEqual({ root: repo });
  });

  it('refuses a path outside a git worktree and names that path', () => {
    const plain = path.join(workspace, 'plain');
    fs.mkdirSync(plain);
    const result = requireGitWorktreeRoot(plain);
    expect(result).toEqual({ refusal: expect.stringContaining(plain) });
    expect(result).toEqual({ refusal: expect.stringContaining('is not in a git repository') });
    expect(result).toEqual({ refusal: expect.stringContaining('codegraph init') });
    expect(result).toEqual({ refusal: expect.stringContaining('--no-git') });
  });

  it('accepts an opted-in ancestor using its canonical spelling', () => {
    const root = path.join(workspace, 'plain');
    const child = path.join(root, 'sub');
    const alias = path.join(workspace, 'alias');
    fs.mkdirSync(child, { recursive: true });
    fs.symlinkSync(root, alias);
    const optIn = { noGit: true, seeded: false };
    registerProject(root, optIn);
    expect(requireGitWorktreeRoot(path.join(alias, 'sub'))).toEqual({ root });
    expect(notARepositoryAnswer(child)).toBeNull();
    const nestedRepo = path.join(root, 'nested-repo');
    fs.mkdirSync(nestedRepo);
    execFileSync('git', ['init', '-q'], { cwd: nestedRepo, stdio: 'ignore' });
    expect(gitRootByStat(nestedRepo)).toBe(nestedRepo);
    expect(requireGitWorktreeRoot(nestedRepo)).toEqual({ root: nestedRepo });
  });
});
