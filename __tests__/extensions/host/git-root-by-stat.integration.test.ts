import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitRootByStat } from '../../../src/extensions/host/server/index-root';
import { indexRootAdmission, resolveRepoAnchor, sessionCallGuard } from '../../../src/extensions/host/server/repo-anchor';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('git worktree roots and admission', () => {
  let tmp: string;
  let repo: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-root-stat-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds the main worktree root', () => {
    expect(gitRootByStat(repo)).toBe(repo);
  });

  it('finds a linked worktree root when .git is a file', () => {
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'init');
    const linked = path.join(tmp, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'linked-test', linked);
    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true);
    expect(gitRootByStat(linked)).toBe(linked);
  });

  it('finds the enclosing worktree from a subfolder', () => {
    expect(gitRootByStat(path.join(repo, 'src'))).toBe(repo);
  });

  it('returns null for a plain folder', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(gitRootByStat(plain)).toBeNull();
  });

  it('refuses a plain path inside a non-git anchor with its resolved path', async () => {
    const anchor = await resolveRepoAnchor(tmp);
    const out = await sessionCallGuard({ projectPath: 'plain' }, anchor);
    expect('answer' in out).toBe(true);
    if ('answer' in out) {
      expect(out.answer.isError).toBeUndefined();
      expect(out.answer.content[0].text).toContain(`${path.join(tmp, 'plain')} is not in a git repository`);
    }
  });

  it('checks the anchor boundary before checking whether a path is in git', async () => {
    const anchor = await resolveRepoAnchor(path.join(repo, 'src'));
    const out = await sessionCallGuard({ projectPath: tmp }, anchor);
    expect('answer' in out).toBe(true);
    if ('answer' in out) {
      expect(out.answer.content[0].text).toContain('outside');
      expect(out.answer.content[0].text).not.toContain('is not in a git repository');
    }
  });

  it('accepts a worktree path inside a non-git anchor', async () => {
    const anchor = await resolveRepoAnchor(tmp);
    expect(await sessionCallGuard({ projectPath: 'repo/src' }, anchor)).toEqual({ projectPath: path.join(repo, 'src') });
  });

  it('refuses a plain index root inside the anchor', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const admit = indexRootAdmission(await resolveRepoAnchor(tmp));
    expect(await admit(plain)).toContain(`${plain} is not in a git repository`);
  });

  it('admits an index root inside a worktree inside the anchor', async () => {
    const admit = indexRootAdmission(await resolveRepoAnchor(tmp));
    expect(await admit(path.join(repo, 'src'))).toBeNull();
  });
});
