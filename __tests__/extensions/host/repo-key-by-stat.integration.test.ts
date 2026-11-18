import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot } from '../../../src/directory';
import { repoKeyByStat } from '../../../src/extensions/host/builder/repo-key-by-stat';
import { canLinkDirs } from '../../helpers/canLinkDirs';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('repoKeyByStat', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repo-key-'))); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('uses the common git directory for a checkout and its linked worktree', () => {
    const repo = path.join(tmp, 'repo');
    const worktree = path.join(tmp, 'worktree');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', worktree);
    const expected = fs.realpathSync(path.join(repo, '.git'));
    expect(repoKeyByStat(repo)).toBe(expected);
    expect(repoKeyByStat(worktree)).toBe(expected);
  });

  it('distinguishes two independent repositories', () => {
    const first = path.join(tmp, 'first');
    const second = path.join(tmp, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    git(first, 'init', '-q');
    git(second, 'init', '-q');
    expect(repoKeyByStat(first)).toBe(fs.realpathSync(path.join(first, '.git')));
    expect(repoKeyByStat(second)).toBe(fs.realpathSync(path.join(second, '.git')));
    expect(repoKeyByStat(first)).not.toBe(repoKeyByStat(second));
  });

  it('falls back to the canonical root for a missing path or a non-git directory', () => {
    const missing = path.join(tmp, 'missing');
    expect(repoKeyByStat(tmp)).toBe(canonicalProjectRoot(tmp));
    expect(repoKeyByStat(missing)).toBe(canonicalProjectRoot(missing));
  });

  it('falls back to the canonical root for a .git file naming a missing gitdir', () => {
    const malformed = path.join(tmp, 'malformed');
    fs.mkdirSync(malformed);
    fs.writeFileSync(path.join(malformed, '.git'), 'gitdir: /no/such/git/directory\n');
    expect(repoKeyByStat(malformed)).toBe(canonicalProjectRoot(malformed));
  });

  it.runIf(canLinkDirs)('falls back to the canonical root for a .git symlink to a missing target', () => {
    const broken = path.join(tmp, 'broken');
    fs.mkdirSync(broken);
    fs.symlinkSync(path.join(tmp, 'missing'), path.join(broken, '.git'));
    expect(repoKeyByStat(broken)).toBe(canonicalProjectRoot(broken));
  });

  it('uses the gitdir itself when its commondir is absent', () => {
    const root = path.join(tmp, 'root');
    const gitdir = path.join(tmp, 'gitdir');
    fs.mkdirSync(root);
    fs.mkdirSync(gitdir);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../gitdir\n');
    expect(repoKeyByStat(root)).toBe(fs.realpathSync(gitdir));
  });
});
