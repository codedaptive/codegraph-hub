/**
 * The Windows filter of a held root's watcher (./holder.ts): {@link isIndexedFileStateCurrent} (./is-indexed-file-state-current.ts) on a read-only
 * open of `root` made for this one check, since the builder keeps no graph of a held root open. False when the
 * index cannot be opened, so the notification reaches the sync.
 */
import CodeGraph from '../../../index';
import { isIndexedFileStateCurrent } from './is-indexed-file-state-current';

export function isIndexedFileStateCurrentOnDisk(root: string, relPath: string): boolean {
  let cg: CodeGraph;
  try {
    cg = CodeGraph.openSync(root, { readOnly: true });
  } catch {
    return false;
  }
  try {
    return isIndexedFileStateCurrent(cg, root, relPath);
  } finally {
    cg.close();
  }
}
