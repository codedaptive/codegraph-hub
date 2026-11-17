/**
 * Whether the scan follows a symlinked folder (R-44). A link whose real target
 * is the project root or inside it is followed. A target outside the root is
 * followed only when an ignore rule re-includes the link's own path, as a file
 * path or as a folder (`!data/runs` or `!data/runs/`); otherwise it is skipped
 * with a debug line. `realpath` may throw; the caller skips the link then.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Ignore } from 'ignore';
import { logDebug } from '../../../errors';
import { escapesRoot, normalizePath } from '../../../utils';

export function followSymlinkedDir(
  rootDir: string,
  realTarget: string,
  relativePath: string,
  matcher: Pick<Ignore, 'test'>,
  realpath: (p: string) => string = fs.realpathSync,
): boolean {
  if (!escapesRoot(normalizePath(path.relative(realpath(rootDir), realTarget)))) return true;
  if (matcher.test(relativePath).unignored || matcher.test(relativePath + '/').unignored) return true;
  logDebug('Skipping symlinked folder outside the root', { relativePath, realTarget });
  return false;
}
