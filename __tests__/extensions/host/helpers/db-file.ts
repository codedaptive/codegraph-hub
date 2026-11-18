import * as path from 'path';

/** The index database of `root`. */
export function dbFile(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}
