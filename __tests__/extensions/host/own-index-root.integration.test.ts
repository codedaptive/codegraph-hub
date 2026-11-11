/**
 * Own index selection (src/extensions/host/server/index-root.ts: ownIndexRootFor, selectOwnIndexRoot).
 *
 * The rule: a git repository nested inside an indexed checkout is its own worktree root. An index above
 * that root belongs to another repository, so it never answers a path inside the nested one. A linked
 * worktree of the same repository (same git common dir) and a sub-project's index are unchanged.
 *
 * Real `git` and real temp directories, as repo-anchor.unit.test.ts: "same repository" is git's own answer
 * (the common dir), so it is driven against git, not against a faked `.git` entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { ownIndexRootFor, selectIndexRoot, selectOwnIndexRoot } from '../../../src/extensions/host/server/index-root';
import { classifyNestedRepository, nestedRepositoryBelow } from '../../../src/sync/worktree';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
}

/** A git repository with `src/` committed (a commit, so a linked worktree of it can be added). */
function initRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('ownIndexRootFor and selectOwnIndexRoot', () => {
  let tree: string;

  beforeEach(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-own-index-root-')));
  });

  afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true });
  });

  it('V1: a separate git repository nested in an indexed checkout is not answered by the checkout\'s index', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const nested = initRepo(path.join(outer, 'nested'));
    const src = path.join(nested, 'src');

    // The index above is selected (the premise), and the path inside the nested repository is not its.
    expect(selectIndexRoot(src)).toBe(outer);
    expect(selectOwnIndexRoot(src)).toBeNull();
    // A path in the nested repository that does not exist yet is inside it too.
    expect(selectOwnIndexRoot(path.join(src, 'not-yet'))).toBeNull();
    expect(ownIndexRootFor(src, outer)).toBeNull();
    expect(ownIndexRootFor(src, null)).toBeNull();
  });

  it('V2: a nested repository with an index of its own is answered by that index', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const nested = initRepo(path.join(outer, 'nested'));
    CodeGraph.initSync(nested).close();
    const src = path.join(nested, 'src');

    expect(selectIndexRoot(src)).toBe(nested);
    expect(selectOwnIndexRoot(src)).toBe(nested);
    expect(ownIndexRootFor(src, nested)).toBe(nested);
  });

  it('V3: a linked worktree of the indexed checkout, with no index of its own, is answered by the checkout\'s index', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const wt = path.join(outer, '.wt', 'x');
    git(outer, 'worktree', 'add', '-q', '-b', 'feature', wt);

    // Same git common dir: the linked worktree is one of the checkout's worktrees, so the index is its own.
    expect(selectOwnIndexRoot(wt)).toBe(outer);
    expect(selectOwnIndexRoot(path.join(wt, 'src'))).toBe(outer);
    expect(ownIndexRootFor(wt, outer)).toBe(outer);
  });

  it('V4: a sub-project index below the checkout (no .git of its own) still leaves the checkout\'s index answering its subdirectory', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const sub = path.join(outer, 'sub');
    fs.mkdirSync(path.join(sub, 'x'), { recursive: true });
    CodeGraph.initSync(sub).close();

    // selectIndexRoot's existing rule: the sub-project's index does not shadow the worktree's own.
    expect(selectIndexRoot(path.join(sub, 'x'))).toBe(outer);
    expect(selectOwnIndexRoot(path.join(sub, 'x'))).toBe(outer);
  });

  it('V5: a subdirectory of the indexed checkout is answered by the checkout\'s index', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const src = path.join(outer, 'src');

    expect(selectIndexRoot(src)).toBe(outer);
    expect(selectOwnIndexRoot(src)).toBe(outer);
    expect(ownIndexRootFor(src, outer)).toBe(outer);
  });

  it('V6: ownIndexRootFor passes a candidate through when the path is in the candidate\'s own repository, and refuses one above a nested repository', () => {
    const outer = initRepo(path.join(tree, 'O'));
    const nested = initRepo(path.join(outer, 'nested'));
    const src = path.join(nested, 'src');

    // A candidate above the nested repository is refused, whichever way it was chosen.
    expect(ownIndexRootFor(src, outer)).toBeNull();
    // A candidate that is the path's own repository stands.
    expect(ownIndexRootFor(src, nested)).toBe(nested);
    expect(ownIndexRootFor(outer, outer)).toBe(outer);
    // No candidate: nothing to own.
    expect(ownIndexRootFor(src, null)).toBeNull();
  });

  it('V7: an indexed directory that is not a git repository does not answer for a git repository inside it', () => {
    const plain = path.join(tree, 'P');
    fs.mkdirSync(plain, { recursive: true });
    CodeGraph.initSync(plain).close();
    const inner = initRepo(path.join(plain, 'g'));
    const x = path.join(inner, 'src');

    // The premise: the plain directory's index is the one selectIndexRoot names for a path inside the repository.
    expect(selectIndexRoot(x)).toBe(plain);
    expect(selectOwnIndexRoot(x)).toBeNull();
  });

  /** Run `fn` with a PATH that holds no git: the git spawns in `fn` fail (they inherit the process environment). */
  function withoutGit<T>(fn: () => T): T {
    const savedPath = process.env.PATH;
    const noGit = path.join(tree, 'no-git-here');
    fs.mkdirSync(noGit, { recursive: true });
    try {
      process.env.PATH = noGit;
      return fn();
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  }

  it('V8: a path in a nested repository answers null while git cannot run (fails closed), and null again with git back (nested)', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const nested = initRepo(path.join(outer, 'nested'));
    const src = path.join(nested, 'src');

    expect(withoutGit(() => ownIndexRootFor(src, outer)), 'git could not run: the outer index is not vouched for').toBeNull();
    expect(withoutGit(() => selectOwnIndexRoot(src))).toBeNull();
    // With git back the answer is the nested repository's own: still not the outer index.
    expect(ownIndexRootFor(src, outer)).toBeNull();
    expect(selectOwnIndexRoot(src)).toBeNull();
  });

  it('V9: a linked worktree of the indexed checkout answers null while git cannot run, and the checkout\'s index again with git back: unknown is not remembered', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const wt = path.join(outer, '.wt', 'x');
    git(outer, 'worktree', 'add', '-q', '-b', 'feature', wt);

    // The broken call comes first: had it been remembered, the call with git back could not answer the checkout.
    expect(withoutGit(() => ownIndexRootFor(wt, outer)), 'git could not run: not vouched for').toBeNull();
    expect(ownIndexRootFor(wt, outer), 'same git common dir: the checkout\'s index is the worktree\'s own').toBe(outer);
    expect(selectOwnIndexRoot(wt)).toBe(outer);
  });

  it('V10: a fatal git error on the candidate (a broken config, exit 128 without "not a git repository") is unknown, not nested; a candidate outside git is still nested', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const nested = initRepo(path.join(outer, 'nested'));
    const src = path.join(nested, 'src');
    const plain = path.join(tree, 'P');
    fs.mkdirSync(plain, { recursive: true });
    const inner = initRepo(path.join(plain, 'g'));

    // Controls: git says the candidate is not in a repository (exit 128, "not a git repository") -> nested;
    // and git answers for both -> nested.
    expect(classifyNestedRepository(path.join(inner, 'src'), plain).kind).toBe('nested');
    expect(classifyNestedRepository(src, outer).kind).toBe('nested');

    // Break the candidate's config: git exits 128 with "fatal: bad config line", a fatal error that says nothing
    // about whether the candidate is a repository (as a safe.directory ownership refusal says nothing).
    fs.writeFileSync(path.join(outer, '.git', 'config'), '[core\nbroken line\n');
    const verdict = classifyNestedRepository(src, outer);
    expect(verdict.kind, 'git could not answer for the candidate: unknown, never nested').toBe('unknown');
    // The path's own repository is unaffected, and nestedRepositoryBelow keeps reporting it as it always has.
    expect(nestedRepositoryBelow(src, outer)?.root).toBe(nested);
    // ownIndexRootFor does not vouch for the candidate. (unknown is never remembered: only a nested verdict is.)
    expect(ownIndexRootFor(src, outer)).toBeNull();
  });

  it('selectOwnIndexRoot is ownIndexRootFor of selectIndexRoot, for every layout above', () => {
    const outer = initRepo(path.join(tree, 'O'));
    CodeGraph.initSync(outer).close();
    const nested = initRepo(path.join(outer, 'nested'));
    const wt = path.join(outer, '.wt', 'x');
    git(outer, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const plain = path.join(tree, 'P');
    fs.mkdirSync(plain, { recursive: true });
    CodeGraph.initSync(plain).close();
    const inner = initRepo(path.join(plain, 'g'));

    for (const p of [path.join(nested, 'src'), wt, path.join(outer, 'src'), path.join(inner, 'src')]) {
      expect(selectOwnIndexRoot(p), p).toBe(ownIndexRootFor(p, selectIndexRoot(p)));
    }
  });
});
