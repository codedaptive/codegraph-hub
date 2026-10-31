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

/** `child` is strictly below `parent`: inside it and not the same directory (both resolved, lexical). */
function isStrictlyBelow(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The worktree root a call on `projectPath` belongs to: the nearest directory at or above it that has a
 * `.git` entry (a directory for a main checkout, a file for a linked worktree or a submodule), found by
 * stats alone. Null outside a git working tree. The path is lexical (`path.resolve` of the input), the same
 * spelling {@link findNearestCodeGraphRoot} uses, so the two compare directly.
 */
export function gitRootByStat(projectPath: string): string | null {
  let dir = path.resolve(projectPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The index root a call on `projectPath` is answered from, or null when none exists yet.
 *
 * `n` is the nearest `.codegraph/` at or above `projectPath` and `g` the worktree root ({@link gitRootByStat}).
 * An index strictly below `g` is a sub-project's: it covers only its own subdirectory, so it cannot answer
 * for the worktree, and the answer is the nearest index at or above `g` (the worktree's own, or an
 * ancestor's, or none). Otherwise `n` stands. An index at a directory that has its own
 * `.git` (a submodule, an embedded clone) is never below the `g` of a path inside it, since that directory
 * is itself `g` there, so it is not skipped.
 */
export function selectIndexRoot(projectPath: string): string | null {
  const n = findNearestCodeGraphRoot(projectPath);
  if (n === null) return null;
  const g = gitRootByStat(projectPath);
  if (g !== null && isStrictlyBelow(n, g)) return findNearestCodeGraphRoot(g);
  return n;
}
