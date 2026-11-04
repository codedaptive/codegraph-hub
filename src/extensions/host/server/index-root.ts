/**
 * Which index answers a call: the helpers the server and the index builder share, so both name the same
 * root for the same `projectPath`.
 *
 * {@link gitRootByStat} and {@link selectIndexRoot} are stat-only (no git is spawned): they run on every tool
 * call, and the builder runs them again before it holds a root. {@link ownIndexRootFor} and
 * {@link selectOwnIndexRoot} add one check that can spawn git, but only for a path that a stat walk shows to
 * have a `.git` entry below the candidate index root; a "nested" answer is memoized, any other is recomputed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findNearestCodeGraphRoot } from '../../../directory';
import { classifyNestedRepository } from '../../../sync/worktree';
import { canonicalGitPath, gitWorktreeRootMayBeBelow } from '../worktree-lifecycle/git';

/** `child` is strictly below `parent`: inside it and not the same directory (both resolved, lexical). */
function isStrictlyBelow(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * `projectPath` by its real location ({@link canonicalGitPath}: symlinks resolved, on-disk casing). A path that
 * does not exist yet keeps its tail: the deepest ancestor that exists is resolved and the missing part is
 * appended, so `link/new/dir` under a symlinked `link` still lands in the directory `link` points to. Without
 * this the up-walks below would follow the alias's own parents (`/work/link` to `/work`) and miss the index
 * and the `.git` of the directory the alias leads into, which the builder (deciding on the real path) builds.
 *
 * Exported for the callers that compare a path with what {@link selectIndexRoot} or {@link gitRootByStat}
 * returned (both spelled by {@link canonicalGitPath}): the path must be put through here first, so both sides
 * of the comparison are in one spelling. A lexical path walked against a real root never meets it.
 */
export function realLocation(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const up = path.dirname(existing);
    if (up === existing) return resolved;
    existing = up;
  }
  const real = canonicalGitPath(existing);
  return existing === resolved ? real : path.join(real, path.relative(existing, resolved));
}

/** {@link gitRootByStat} for a path already given by its real location. */
function gitRootOfReal(real: string): string | null {
  let dir = real;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The worktree root a call on `projectPath` belongs to: the nearest directory at or above it that has a
 * `.git` entry (a directory for a main checkout, a file for a linked worktree or a submodule), found by
 * stats alone. Null outside a git working tree. The walk starts from the path's real location
 * ({@link realLocation}), so an alias (a symlink into a nested checkout) belongs to the checkout it leads
 * into, and the result is spelled by {@link canonicalGitPath}, the spelling {@link selectIndexRoot} returns.
 */
export function gitRootByStat(projectPath: string): string | null {
  return gitRootOfReal(realLocation(projectPath));
}

/**
 * The index root a call on `projectPath` is answered from by a handler with no index builder (the CLI, the
 * in-process read-only fallback, query workers), or null when none exists yet. It can be an index above a git
 * repository nested around the path: a builder engine does not take that one and uses {@link selectOwnIndexRoot}.
 *
 * Decided on the real location of `projectPath` ({@link realLocation}), not its spelling: a symlink into a
 * nested checkout is answered from that checkout's index, the one the builder builds for it, and the root
 * returned is spelled by {@link canonicalGitPath}. A caller that compares that root with a path walks the
 * path from {@link realLocation} (`worktreeSeedMayApply`, seed.ts `ensureWorktreeIndex`); the ones that only
 * open or hold the root (the MCP handler, the builder's `ensure`) never compare it with a lexical path.
 *
 * `n` is the nearest `.codegraph/` at or above that location and `g` the worktree root ({@link gitRootByStat}).
 * An index strictly below `g` is a sub-project's: it covers only its own subdirectory, so it cannot answer
 * for the worktree, and the answer is the nearest index at or above `g` (the worktree's own, or an
 * ancestor's, or none). Otherwise `n` stands. An index at a directory that has its own
 * `.git` (a submodule, an embedded clone) is never below the `g` of a path inside it, since that directory
 * is itself `g` there, so it is not skipped. An index above that directory is still what this returns for a
 * path inside it that has no index of its own (see {@link ownIndexRootFor} for the builder engines' rule).
 */
export function selectIndexRoot(projectPath: string): string | null {
  const real = realLocation(projectPath);
  const n = findNearestCodeGraphRoot(real);
  if (n === null) return null;
  const g = gitRootOfReal(real);
  if (g !== null && isStrictlyBelow(n, g)) return findNearestCodeGraphRoot(g);
  return n;
}

/**
 * The (real path, candidate) pairs {@link classifyNestedRepository} found nested, and only those. A nested
 * answer is stable for a path and an index root, and the stat pre-check in {@link ownIndexRootFor} keeps the
 * git spawns off the hot path. Neither of the other two verdicts is remembered: `unknown` (git failed) must be
 * asked again once git is back, and `not-nested` (a linked worktree of the candidate's own repository, the
 * only common case) is not remembered because nothing here proves it stays true (the worktree can be removed
 * and the path become another repository). The cost is up to three git spawns per call on a path that passes
 * the stat pre-check and is not nested: in practice a linked worktree that still borrows its checkout's index
 * until the builder seeds it.
 * A nested answer that stops being true (the repository is removed) keeps the cached answer until the memo clears.
 * Bounded: a long-lived server queried with many paths drops the whole memo and starts over rather than grow;
 * 512 entries is ample for the paths one session names, and a clear costs three git spawns per path.
 */
const nestedMemo = new Set<string>();
const NESTED_MEMO_MAX = 512;

function isOwnRepository(real: string, candidate: string): boolean {
  const key = `${real}\0${candidate}`;
  if (nestedMemo.has(key)) return false;
  const verdict = classifyNestedRepository(real, candidate);
  if (verdict.kind === 'not-nested') return true;
  // Unknown: git could not answer, so the candidate is not shown to be the path's own repository's. Not remembered.
  if (verdict.kind === 'nested') {
    if (nestedMemo.size >= NESTED_MEMO_MAX) nestedMemo.clear();
    nestedMemo.add(key);
  }
  return false;
}

/**
 * `candidate` (an index root {@link selectIndexRoot} or the caller chose for `projectPath`), or null when it is
 * not shown to be `projectPath`'s own. An index above the git root of the path is never selected: a git
 * repository nested strictly below `candidate` is its own worktree root with its own git common dir, so
 * `candidate`'s index belongs to another repository and is not selected, admitted or refused on its behalf.
 * That holds whether or not the outer index covers the nested repository: on a builder engine an embedded clone
 * the outer index does hold (not gitignored) or a submodule is not answered from the outer index either, it
 * gets its own. The nested repository's own index (a `.codegraph/` AT its root: {@link selectIndexRoot} skips
 * one strictly below a git root) is a candidate that passes. A null `candidate` stays null.
 *
 * Unchanged by this check: a path in a linked worktree of `candidate`'s own repository (same git common dir:
 * the borrowed-index case), a sub-project's index below the worktree root, and any path with no `.git` entry
 * between it and `candidate`. That last test is a stat walk, run first, so the common call spawns no git.
 *
 * Fails closed: when git cannot answer (not installed, a failed spawn, a timeout, no toplevel or common dir for
 * the path, or a failure reading the candidate's common dir that is not "the candidate is not in a repository"),
 * the verdict is `unknown` and the result is null. The call then goes to the builder, which cannot seed or build
 * without git and answers the not-indexed guidance; `unknown` is not remembered ({@link nestedMemo}), so the next
 * call asks git again. A candidate that is not in a git repository at all counts as nested, as in
 * `nestedRepositoryBelow` (sync/worktree.ts).
 */
export function ownIndexRootFor(projectPath: string, candidate: string | null): string | null {
  if (candidate === null) return null;
  const real = realLocation(projectPath);
  if (!gitWorktreeRootMayBeBelow(real, candidate)) return candidate;
  return isOwnRepository(real, candidate) ? candidate : null;
}

/**
 * {@link selectIndexRoot} for the engines that build their own indexes (the server with an index builder, and
 * the builder itself): the index root that is `projectPath`'s own ({@link ownIndexRootFor}). Null for a path in
 * a nested repository that has no index of its own: the builder seeds or builds one for that repository
 * (unless CODEGRAPH_NO_AUTO_SEED=1 turns automatic indexing off), the call answers the building note while that
 * runs, and the not-indexed guidance when the copy or build fails. Handlers with no builder (the CLI, the
 * in-process read-only fallback, query workers) keep {@link selectIndexRoot}.
 */
export function selectOwnIndexRoot(projectPath: string): string | null {
  return ownIndexRootFor(projectPath, selectIndexRoot(projectPath));
}
