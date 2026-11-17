/**
 * Files under directory links that a git root's ignore re-includes (S-76, R-44).
 *
 * On a git root the scan takes git's own file list, and git lists a directory
 * link as one entry without its contents. A link whose real target leaves the
 * root is walked here only when the root ignore re-includes the link's path
 * (`followSymlinkedDir`). A link into the root is not followed: on the git
 * route git's list is what the index holds for in-root content, so an alias
 * never indexes a file twice (S-76 (b)).
 *
 * Only listed paths a negation rule matches reach the file system, so a large
 * git list costs at most two ignore tests per path (file form, then folder form). The walk skips `.git` and CodeGraph
 * data folders, prunes with `keep`, follows nested outside links by the same
 * rule, guards cycles by real folder path, and skips any entry it cannot read.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Ignore } from 'ignore';
import { isCodeGraphDataDir } from '../../../directory';
import { escapesRoot, normalizePath } from '../../../utils';
import { followSymlinkedDir } from './follow-symlinked-dir';

type FsOps = {
  isLink(abs: string): boolean;
  realpath(abs: string): string;
  kind(abs: string): 'dir' | 'file' | 'other';
  readdir(abs: string): Array<{ name: string; kind: 'dir' | 'file' | 'link' | 'other' }>;
};

type Walk = {
  rootDir: string;
  realRoot: string;
  rootIgnore: Pick<Ignore, 'test'>;
  keep: (rel: string, isDir: boolean) => boolean;
  fsOps: FsOps;
  seen: Set<string>;
  out: string[];
};

const kindOf = (s: fs.Stats | fs.Dirent): 'dir' | 'file' | 'other' =>
  s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';

const nodeFs: FsOps = {
  isLink: (abs) => fs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
  realpath: fs.realpathSync,
  kind: (abs) => kindOf(fs.statSync(abs)),
  readdir: (abs) =>
    fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
      name: d.name,
      kind: d.isSymbolicLink() ? 'link' : kindOf(d),
    })),
};

export function filesUnderReincludedLinks(
  rootDir: string,
  listed: Iterable<string>,
  rootIgnore: Pick<Ignore, 'test'>,
  keep: (rel: string, isDir: boolean) => boolean,
  fsOps: FsOps = nodeFs,
): string[] {
  let realRoot: string;
  try {
    realRoot = fsOps.realpath(rootDir);
  } catch {
    return [];
  }
  const walk: Walk = { rootDir, realRoot, rootIgnore, keep, fsOps, seen: new Set(), out: [] };
  for (const rel of listed) {
    if (!rootIgnore.test(rel).unignored && !rootIgnore.test(rel + '/').unignored) continue;
    const abs = path.join(rootDir, rel);
    // A listed file link is already one of git's files; only directory links are walked.
    if (safe(() => fsOps.isLink(abs) && fsOps.kind(abs) === 'dir')) visitDirLink(walk, rel, abs);
  }
  return walk.out;
}

/** Runs `op`, turning any thrown error into `undefined`. */
function safe<T>(op: () => T): T | undefined {
  try {
    return op();
  } catch {
    return undefined;
  }
}

/** Walks a directory link when its target leaves the root and the root ignore re-includes its path. */
function visitDirLink(walk: Walk, rel: string, abs: string): void {
  const real = safe(() => walk.fsOps.realpath(abs));
  if (real === undefined || !escapesRoot(normalizePath(path.relative(walk.realRoot, real)))) return;
  const follow = safe(() => followSymlinkedDir(walk.rootDir, real, rel, walk.rootIgnore, walk.fsOps.realpath));
  if (follow && walk.keep(rel, true)) walkDir(walk, rel, abs, real);
}

/** Collects kept files under `abs`, read through its link path; `real` guards against cycles. */
function walkDir(walk: Walk, rel: string, abs: string, real: string): void {
  if (walk.seen.has(real)) return;
  walk.seen.add(real);
  const entries = safe(() => walk.fsOps.readdir(abs)) ?? [];
  for (const { name, kind } of entries) {
    if (name === '.git' || isCodeGraphDataDir(name)) continue;
    const childRel = `${rel}/${name}`;
    const childAbs = path.join(abs, name);
    // A nested link counts as the kind of its target.
    const target = kind === 'link' ? safe(() => walk.fsOps.kind(childAbs)) : kind;
    if (target === 'file') {
      if (walk.keep(childRel, false)) walk.out.push(childRel);
    } else if (kind === 'link' && target === 'dir') {
      visitDirLink(walk, childRel, childAbs);
    } else if (kind === 'dir' && walk.keep(childRel, true)) {
      const childReal = safe(() => walk.fsOps.realpath(childAbs));
      if (childReal !== undefined) walkDir(walk, childRel, childAbs, childReal);
    }
  }
}
