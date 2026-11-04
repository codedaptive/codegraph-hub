/**
 * Index selection (src/extensions/host/server/index-root.ts): the one rule the server and the index builder
 * share for which `.codegraph/` answers a call. Stat-only, so the cases build directory trees and a few empty
 * `.git` entries, never a repository.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { gitRootByStat, selectIndexRoot } from '../../../src/extensions/host/server/index-root';
import { worktreeSeedMayApply } from '../../../src/extensions/host/worktree-lifecycle/seed-check';

describe('selectIndexRoot and gitRootByStat', () => {
  let tree: string;

  beforeEach(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-index-root-')));
  });

  afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true });
  });

  /** A directory, optionally a checkout (a `.git` directory, or a file as a linked worktree has) and optionally indexed. */
  function dir(rel: string, opts: { git?: 'dir' | 'file'; index?: boolean } = {}): string {
    const d = path.join(tree, rel);
    fs.mkdirSync(d, { recursive: true });
    if (opts.git === 'dir') fs.mkdirSync(path.join(d, '.git'));
    if (opts.git === 'file') fs.writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n');
    if (opts.index) CodeGraph.initSync(d).close();
    return d;
  }

  it('gitRootByStat is the nearest directory at or above the path with a .git entry, a file or a directory', () => {
    const main = dir('main', { git: 'dir' });
    const linked = dir('linked', { git: 'file' });
    const deep = dir('main/a/b/c');
    expect(gitRootByStat(main)).toBe(main);
    expect(gitRootByStat(deep)).toBe(main);
    expect(gitRootByStat(linked)).toBe(linked);
    expect(gitRootByStat(path.join(linked, 'src'))).toBe(linked);
    // Outside any checkout, and a path that does not exist (the walk is lexical).
    expect(gitRootByStat(dir('plain'))).toBeNull();
    expect(gitRootByStat(path.join(main, 'not', 'yet'))).toBe(main);
  });

  it('is null when no index exists at or above the path', () => {
    expect(selectIndexRoot(dir('w', { git: 'dir' }))).toBeNull();
    expect(selectIndexRoot(dir('plain'))).toBeNull();
  });

  it('is the worktree\'s own index for a path in it, at the root or below', () => {
    const w = dir('w', { git: 'file', index: true });
    expect(selectIndexRoot(w)).toBe(w);
    expect(selectIndexRoot(dir('w/src/deep'))).toBe(w);
  });

  it('a sub-project index strictly below the worktree root does not shadow the worktree\'s own index', () => {
    const w = dir('w', { git: 'file', index: true });
    const sub = dir('w/sub', { index: true });
    expect(selectIndexRoot(sub)).toBe(w);
    expect(selectIndexRoot(dir('w/sub/src'))).toBe(w);
  });

  it('a sub-project index below a worktree that has none resolves past it: to an ancestor\'s index, else null', () => {
    const w = dir('w', { git: 'file' });
    dir('w/sub', { index: true });
    expect(selectIndexRoot(path.join(w, 'sub'))).toBeNull();
    // An ancestor directory's index (a plain directory above the checkout) answers instead.
    const above = dir('above', { index: true });
    const w2 = dir('above/w2', { git: 'file' });
    dir('above/w2/sub', { index: true });
    expect(selectIndexRoot(path.join(w2, 'sub'))).toBe(above);
  });

  it('an index at a directory that has its own .git (a submodule, an embedded clone) is not skipped', () => {
    const w = dir('w', { git: 'dir', index: true });
    const embedded = dir('w/vendor/lib', { git: 'dir', index: true });
    expect(selectIndexRoot(path.join(embedded, 'src'))).toBe(embedded);
    expect(selectIndexRoot(embedded)).toBe(embedded);
    expect(selectIndexRoot(path.join(w, 'src'))).toBe(w);
  });

  it('outside git the nearest index stands', () => {
    const outer = dir('outer', { index: true });
    dir('outer/inner', { index: true });
    expect(selectIndexRoot(path.join(outer, 'inner', 'x'))).toBe(path.join(outer, 'inner'));
    expect(selectIndexRoot(path.join(outer, 'x'))).toBe(outer);
  });

  it('a worktree nested inside another checkout\'s directory keeps its own index root', () => {
    // main (indexed) holds .worktrees/nested (a linked worktree, indexed): a path in nested is nested's.
    dir('main', { git: 'dir', index: true });
    const nested = dir('main/.worktrees/nested', { git: 'file', index: true });
    expect(selectIndexRoot(path.join(nested, 'src'))).toBe(nested);
    // Not yet indexed: the index above it is main's, which is at/above the worktree root, so it stands (the borrowed case).
    const bare = dir('main/.worktrees/bare', { git: 'file' });
    expect(selectIndexRoot(bare)).toBe(path.join(tree, 'main'));
  });

  // A symlink into a nested checkout is that checkout's: the builder builds /work/nested-repo for
  // projectPath=/work/link, so once that index exists the answer path must find it too. Selecting by the
  // alias's own parents (/work/link -> /work) never reaches /work/nested-repo/.codegraph.
  it.runIf(process.platform !== 'win32')('a symlink into a nested checkout selects that checkout\'s index, and its worktree root is the checkout', () => {
    const work = dir('work');
    const nested = dir('work/nested-repo', { git: 'dir' });
    dir('work/nested-repo/src');
    const link = path.join(work, 'link');
    fs.symlinkSync(path.join(nested, 'src'), link);
    const deepLink = path.join(link, 'not', 'yet');

    // No index yet: the builder is the one to make it; nothing answers for the alias.
    expect(selectIndexRoot(link)).toBeNull();
    expect(gitRootByStat(link)).toBe(nested);
    expect(gitRootByStat(deepLink), 'a path that does not exist yet keeps its tail under the resolved ancestor').toBe(nested);

    CodeGraph.initSync(nested).close();
    expect(selectIndexRoot(link)).toBe(nested);
    expect(selectIndexRoot(deepLink)).toBe(nested);
    expect(selectIndexRoot(path.join(nested, 'src')), 'the real spelling is unchanged').toBe(nested);
    // An index above the alias's own parent does not shadow the nested checkout's, and vice versa.
    CodeGraph.initSync(work).close();
    expect(selectIndexRoot(link)).toBe(nested);
    expect(selectIndexRoot(path.join(work, 'elsewhere'))).toBe(work);
  });

  // The precheck on every tool call compares the path with selectIndexRoot's root, which is spelled by the real
  // location. Walked lexically, /alias/repo/src meets /alias/repo/.git before it reaches /real/repo, so an
  // already-held index looked like it might need a seed and the handler asked the builder again.
  it.runIf(process.platform !== 'win32')('worktreeSeedMayApply through a symlinked ancestor of an indexed checkout is false, as for the real spelling', () => {
    const repo = dir('real/repo', { git: 'dir', index: true });
    dir('real/repo/src');
    const alias = path.join(tree, 'alias');
    fs.symlinkSync(path.join(tree, 'real'), alias);

    expect(worktreeSeedMayApply(path.join(repo, 'src'))).toBe(false);
    expect(worktreeSeedMayApply(path.join(alias, 'repo', 'src'))).toBe(false);
    expect(worktreeSeedMayApply(path.join(alias, 'repo'))).toBe(false);
    expect(worktreeSeedMayApply(path.join(alias, 'repo', 'not', 'yet'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('worktreeSeedMayApply stays true through a symlinked ancestor for a checkout with no index, or with a checkout below the index', () => {
    // No index anywhere: the builder decides.
    dir('real/bare', { git: 'dir' });
    dir('real/bare/src');
    // A checkout with no index of its own below an index that is not its own: a seed may apply.
    dir('real/outer', { index: true });
    dir('real/outer/repo', { git: 'dir' });
    dir('real/outer/repo/src');
    const alias = path.join(tree, 'alias');
    fs.symlinkSync(path.join(tree, 'real'), alias);

    expect(worktreeSeedMayApply(path.join(alias, 'bare', 'src'))).toBe(true);
    expect(worktreeSeedMayApply(path.join(tree, 'real', 'outer', 'repo', 'src'))).toBe(true);
    expect(worktreeSeedMayApply(path.join(alias, 'outer', 'repo', 'src'))).toBe(true);
  });
});
