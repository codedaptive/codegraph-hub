/**
 * What the codegraph.json `include` walker does with a symlink met below an
 * include root (S-77, R-44). A link to a directory is walked only when
 * followSymlinkedDir allows it (its real target is inside the root, or the
 * root ignore re-includes the link's path), so a wildcard include cannot carry
 * the scan out of the root. A link to a file is considered wherever it points.
 * A broken or unreadable link, or one to anything else, is skipped: the
 * answer is null and this function never throws.
 */
import * as fs from 'fs';
import type { Ignore } from 'ignore';
import { followSymlinkedDir } from './follow-symlinked-dir';

const nodeFsOps = {
  realpath: (p: string): string => fs.realpathSync(p),
  kind(p: string): 'dir' | 'file' | 'other' {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() ? 'file' : 'other';
  },
};

export function includeWalkLinkKind(
  rootDir: string,
  abs: string,
  rel: string,
  rootIgnore: Pick<Ignore, 'test'>,
  fsOps: {
    realpath(p: string): string;
    kind(p: string): 'dir' | 'file' | 'other';
  } = nodeFsOps,
): 'dir' | 'file' | null {
  try {
    const real = fsOps.realpath(abs);
    switch (fsOps.kind(abs)) {
      case 'dir':
        return followSymlinkedDir(rootDir, real, rel, rootIgnore, fsOps.realpath) ? 'dir' : null;
      case 'file':
        return 'file';
      default:
        return null;
    }
  } catch {
    return null;
  }
}
