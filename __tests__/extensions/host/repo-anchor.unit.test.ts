/**
 * The repo anchor and the one call guard (src/extensions/host/server/repo-anchor.ts).
 *
 * Real `git`, real temp directories: the guard's inside/outside rule is "same
 * git common dir" in a repository and "the launch directory's subtree" outside
 * one, so both are driven against what git and the filesystem actually answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MISSING_PROJECT_PATH_TEXT,
  indexRootAdmission,
  resolveRepoAnchor,
  sessionCallGuard,
  type RepoAnchor,
} from '../../../src/extensions/host/server/repo-anchor';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

const text = (answer: { content: Array<{ text: string }> }): string => answer.content[0]!.text;

describe('MISSING_PROJECT_PATH_TEXT', () => {
  it('is the exact required projectPath answer', () => {
    expect(MISSING_PROJECT_PATH_TEXT).toBe('missing argument: root path to the code you wish to query');
  });
});

describe('resolveRepoAnchor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-')));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a launch in a repository subdirectory anchors on the worktree root and the common dir', async () => {
    const repo = path.join(tmp, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    const anchor = await resolveRepoAnchor(path.join(repo, 'src', 'deep'));
    expect(anchor.launchDir).toBe(path.join(repo, 'src', 'deep'));
    expect(anchor.root).toBe(repo);
    expect(anchor.commonDir).toBe(path.join(repo, '.git'));
  });

  it('a linked worktree has its own root and the main checkout\'s common dir', async () => {
    const repo = path.join(tmp, 'repo');
    initRepo(repo);
    const wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const anchor = await resolveRepoAnchor(wt);
    expect(anchor.root).toBe(wt);
    expect(anchor.commonDir).toBe(path.join(repo, '.git'));
  });

  it('a launch outside any repository is its own root with no common dir', async () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    const anchor = await resolveRepoAnchor(dir);
    expect(anchor).toEqual({ launchDir: dir, root: dir, commonDir: null });
  });

  it('reports the realpath of a launch directory given through a link', async () => {
    if (process.platform === 'win32') return;
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    const link = path.join(tmp, 'link');
    fs.symlinkSync(dir, link, 'dir');
    const anchor = await resolveRepoAnchor(link);
    expect(anchor.launchDir).toBe(dir);
    expect(anchor.root).toBe(dir);
  });
});

describe('sessionCallGuard', () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  let anchor: RepoAnchor;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-guard-')));
    repo = path.join(tmp, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, 'src'));
    wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    anchor = await resolveRepoAnchor(repo);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('required projectPath', () => {
    for (const [label, args] of [
      ['missing', {}],
      ['undefined', { projectPath: undefined }],
      ['null', { projectPath: null }],
      ['empty', { projectPath: '' }],
      ['blank', { projectPath: '   \t' }],
      ['a number', { projectPath: 42 }],
      ['an object', { projectPath: { path: repo } }],
    ] as Array<[string, Record<string, unknown>]>) {
      it(`${label} gets exactly the missing-argument text, success-shaped`, async () => {
        const out = await sessionCallGuard(args, anchor);
        expect('answer' in out).toBe(true);
        if (!('answer' in out)) return;
        expect(text(out.answer)).toBe(MISSING_PROJECT_PATH_TEXT);
        expect(out.answer.isError).toBeFalsy();
        expect(out.answer.content).toHaveLength(1);
      });
    }

    it('is answered before the anchor is consulted, even with no anchor', async () => {
      const out = await sessionCallGuard({}, null);
      expect('answer' in out && text(out.answer)).toBe(MISSING_PROJECT_PATH_TEXT);
    });
  });

  describe('a session with no anchor', () => {
    it('answers success-shaped guidance to restart the session', async () => {
      const out = await sessionCallGuard({ projectPath: repo }, null);
      expect('answer' in out).toBe(true);
      if (!('answer' in out)) return;
      expect(out.answer.isError).toBeFalsy();
      expect(text(out.answer)).toMatch(/did not report the directory/);
      expect(text(out.answer)).toMatch(/Restart the session/);
      expect(text(out.answer)).not.toBe(MISSING_PROJECT_PATH_TEXT);
    });
  });

  describe('repo anchor', () => {
    it('the anchor root itself, a subdirectory and a not-yet-created path are inside', async () => {
      for (const given of [repo, path.join(repo, 'src'), path.join(repo, 'src', 'not-created-yet', 'x.ts')]) {
        const out = await sessionCallGuard({ projectPath: given }, anchor);
        expect(out, given).toEqual({ projectPath: given });
      }
    });

    it('a sibling worktree of the repository is inside, and its subdirectories', async () => {
      fs.mkdirSync(path.join(wt, 'lib'));
      for (const given of [wt, path.join(wt, 'lib')]) {
        const out = await sessionCallGuard({ projectPath: given }, anchor);
        expect(out, given).toEqual({ projectPath: given });
      }
    });

    it('every worktree is inside whichever worktree the session was launched in', async () => {
      const fromWt = await resolveRepoAnchor(wt);
      expect(await sessionCallGuard({ projectPath: repo }, fromWt)).toEqual({ projectPath: repo });
      expect(await sessionCallGuard({ projectPath: wt }, fromWt)).toEqual({ projectPath: wt });
    });

    it('an unrelated repository is outside: guidance naming the anchor, never isError', async () => {
      const other = path.join(tmp, 'other');
      initRepo(other);
      const out = await sessionCallGuard({ projectPath: other }, anchor);
      expect('answer' in out).toBe(true);
      if (!('answer' in out)) return;
      expect(out.answer.isError).toBeFalsy();
      expect(text(out.answer)).toContain(anchor.root);
      expect(text(out.answer)).toMatch(/answers only for the repository/);
      expect(text(out.answer)).toMatch(/worktrees/);
      expect(text(out.answer)).toContain('projectPath');
      expect(text(out.answer)).not.toBe(MISSING_PROJECT_PATH_TEXT);
    });

    it('a plain directory and the filesystem root are outside', async () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      for (const given of [plain, tmp, path.parse(tmp).root]) {
        const out = await sessionCallGuard({ projectPath: given }, anchor);
        expect('answer' in out, given).toBe(true);
      }
    });

    it('a nested repository with its own git common dir is outside, though it sits under the anchor', async () => {
      const nested = path.join(repo, 'vendor', 'nested');
      initRepo(nested);
      for (const given of [nested, path.join(nested, 'sub-not-created')]) {
        const out = await sessionCallGuard({ projectPath: given }, anchor);
        expect('answer' in out, given).toBe(true);
        if ('answer' in out) expect(text(out.answer)).toContain(anchor.root);
      }
    });

    it('a relative projectPath resolves against the launch directory, not the process cwd', async () => {
      const out = await sessionCallGuard({ projectPath: 'src' }, anchor);
      expect(out).toEqual({ projectPath: path.join(repo, 'src') });
      // ../wt climbs out of the launch directory into the sibling worktree.
      const sibling = await sessionCallGuard({ projectPath: path.join('..', 'wt') }, anchor);
      expect(sibling).toEqual({ projectPath: wt });
      // ../.. climbs out of the repository altogether.
      const escaped = await sessionCallGuard({ projectPath: path.join('..', '..') }, anchor);
      expect('answer' in escaped).toBe(true);
    });

    it.runIf(process.platform !== 'win32')('a link inside the repository that points at another repository is outside', async () => {
      const other = path.join(tmp, 'other');
      initRepo(other);
      const link = path.join(repo, 'src', 'escape');
      fs.symlinkSync(other, link, 'dir');
      const out = await sessionCallGuard({ projectPath: link }, anchor);
      expect('answer' in out).toBe(true);
    });

    it('answers the same for a repeated path (the memo changes no verdict)', async () => {
      const other = path.join(tmp, 'other');
      initRepo(other);
      for (let i = 0; i < 3; i++) {
        expect('projectPath' in (await sessionCallGuard({ projectPath: wt }, anchor))).toBe(true);
        expect('answer' in (await sessionCallGuard({ projectPath: other }, anchor))).toBe(true);
      }
    });
  });

  describe('a launch directory outside any repository: the directory and its subtree', () => {
    let launch: string;
    let plainAnchor: RepoAnchor;

    beforeEach(async () => {
      launch = path.join(tmp, 'workspace');
      fs.mkdirSync(path.join(launch, 'svc-a'), { recursive: true });
      plainAnchor = await resolveRepoAnchor(launch);
      expect(plainAnchor.commonDir).toBeNull();
    });

    it('the directory, its subdirectories and not-yet-created paths are inside', async () => {
      for (const given of [launch, path.join(launch, 'svc-a'), path.join(launch, 'svc-b', 'not-yet')]) {
        const out = await sessionCallGuard({ projectPath: given }, plainAnchor);
        expect(out, given).toEqual({ projectPath: given });
      }
    });

    it('a sibling directory, the parent and an escaping relative path are outside, naming the anchor', async () => {
      const sibling = path.join(tmp, 'workspace-sibling');
      fs.mkdirSync(sibling);
      for (const given of [sibling, tmp, path.join('..', 'workspace-sibling')]) {
        const out = await sessionCallGuard({ projectPath: given }, plainAnchor);
        expect('answer' in out, given).toBe(true);
        if (!('answer' in out)) continue;
        expect(out.answer.isError).toBeFalsy();
        expect(text(out.answer)).toContain(launch);
      }
    });

    it('a directory whose name merely starts like the anchor\'s is outside', async () => {
      // `workspace-sibling` shares the prefix `workspace`: a string-prefix test would let it in.
      const lookalike = path.join(tmp, 'workspace-sibling');
      fs.mkdirSync(lookalike);
      const out = await sessionCallGuard({ projectPath: lookalike }, plainAnchor);
      expect('answer' in out).toBe(true);
    });

    it('a relative projectPath resolves against the launch directory', async () => {
      const out = await sessionCallGuard({ projectPath: 'svc-a' }, plainAnchor);
      expect(out).toEqual({ projectPath: path.join(launch, 'svc-a') });
    });

    it.runIf(process.platform !== 'win32')('a link inside the directory that points outside it is outside', async () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      const link = path.join(launch, 'escape');
      fs.symlinkSync(outside, link, 'dir');
      const out = await sessionCallGuard({ projectPath: link }, plainAnchor);
      expect('answer' in out).toBe(true);
    });
  });
});

describe('indexRootAdmission: the index a call is answered from', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admit-')));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('admits the repository, its worktrees and a nested directory of either; refuses the directory above and other repositories', async () => {
    const repo = path.join(tmp, 'outer', 'repo');
    initRepo(repo);
    const wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const other = path.join(tmp, 'other');
    initRepo(other);
    const admit = indexRootAdmission(await resolveRepoAnchor(repo));

    for (const root of [repo, wt]) expect(await admit(root), root).toBeNull();
    for (const root of [path.join(tmp, 'outer'), other, tmp]) {
      const refusal = await admit(root);
      expect(refusal, root).not.toBeNull();
      expect(refusal).toContain(repo);
      expect(refusal).toContain(`is at ${root},`);
    }
  });

  it('outside a repository the anchor directory and its subtree are admitted, the directory above is not', async () => {
    const launch = path.join(tmp, 'outer', 'workspace');
    fs.mkdirSync(path.join(launch, 'svc'), { recursive: true });
    const admit = indexRootAdmission(await resolveRepoAnchor(launch));
    expect(await admit(launch)).toBeNull();
    expect(await admit(path.join(launch, 'svc'))).toBeNull();
    const refusal = await admit(path.join(tmp, 'outer'));
    expect(refusal).toContain(launch);
  });
});
