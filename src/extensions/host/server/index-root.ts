/**
 * Which index answers a call: the one helper the server and the index builder share, so both name the same
 * root for the same `projectPath`.
 *
 * Both functions are stat-only (no git is spawned): they run on every tool call, and the builder runs them
 * again before it holds a root.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findNearestCodeGraphRoot } from '../../../directory';
import { canonicalGitPath } from '../worktree-lifecycle/git';

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
 * The index root a call on `projectPath` is answered from, or null when none exists yet.
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
 * is itself `g` there, so it is not skipped.
 */
export function selectIndexRoot(projectPath: string): string | null {
  const real = realLocation(projectPath);
  const n = findNearestCodeGraphRoot(real);
  if (n === null) return null;
  const g = gitRootOfReal(real);
  if (g !== null && isStrictlyBelow(n, g)) return findNearestCodeGraphRoot(g);
  return n;
}
