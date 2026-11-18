/**
 * Whether the index's record for `relPath` (project-relative, POSIX) still matches the file on disk: tracked,
 * a regular file, and the same size and whole-millisecond mtime. False for an untracked file, a missing or
 * unreadable one (a removal or a transient failure must reach the sync), or when `cg` is null or unreadable.
 *
 * The same comparison as `CodeGraph.isIndexedFileStateCurrent` (src/index.ts, private; `CodeGraph.watch()`
 * passes it to its watcher on Windows only, to discard NTFS last-access notifications, #1451), built on the
 * public `getFile` because the builder's watcher (./holder.ts) queues its syncs and so cannot use
 * `CodeGraph.watch()`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../../../index';

export function isIndexedFileStateCurrent(
  cg: Pick<CodeGraph, 'getFile'> | null,
  projectRoot: string,
  relPath: string,
): boolean {
  if (cg === null) return false;
  try {
    const tracked = cg.getFile(relPath);
    if (!tracked) return false;
    const stat = fs.statSync(path.join(projectRoot, relPath));
    return (
      stat.isFile() &&
      Number.isFinite(stat.mtimeMs) &&
      Number.isFinite(tracked.modifiedAt) &&
      stat.size === tracked.size &&
      Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)
    );
  } catch {
    return false;
  }
}
