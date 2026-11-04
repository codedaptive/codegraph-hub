/**
 * The index-currency check for `codegraph orphans` (run before any symbol is
 * counted). The diff runs from the merge base to the working tree, and the
 * index must describe that same working tree for its symbols and line ranges
 * to agree with the diff. Uncommitted edits are included, not refused: the
 * check catches an index that has not caught up with them.
 *
 * For every changed file whose status is not deleted, that has a `files` row,
 * and that exists in the working tree, compare sha256 of
 * `indexedHashInput(size, content)` against `files.content_hash`. The content
 * is read the way the indexer reads it (`readBoundedSourceSync`, through a
 * symlink wherever it points), not the leak-safe way the content-serving reads
 * do, so an indexed symlink leading out of the root compares like any other file.
 *
 * Limits, kept deliberately:
 * - A changed file with no `files` row (never indexed, or excluded from the
 *   index) is not checked.
 * - A path missing from the working tree is not checked; a deleted one is not
 *   in the set at all.
 * - A file that exists but cannot be read (permissions, not a regular file) is
 *   not checked.
 * - The check names only files in the diff, not every file in the index.
 *
 * Imports only upstream modules (`src/db`, `src/file-limits`); it opens its
 * own read-only connection for the `files` query and closes it on every path.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../../../db';
import { indexedHashInput, readBoundedSourceSync } from '../../../file-limits';

/** The part of a changed file this check reads: `blast/diff.ts`'s `ChangedFile` fits. */
export interface FreshnessFile {
  path: string;
  status: string;
}

/** Project-relative paths the check names, in diff order. */
export interface IndexCurrency {
  /** Changed files whose working-tree content hashes differently from the index. */
  unsynced: string[];
}

/** Paths the failure message lists before "and N more". */
const LISTED_PATHS = 5;

/** Whether a diff path may be joined onto the project root: relative, nothing climbing out. */
function isInsideRoot(rel: string): boolean {
  if (rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/).every((s) => s !== '..');
}

/** The sha256 the index would store for the file at `abs`, or null when it cannot be read. */
function indexedHashOf(abs: string): string | null {
  try {
    const { stats, bytes } = readBoundedSourceSync(abs);
    return createHash('sha256').update(indexedHashInput(stats.size, () => (bytes as Buffer).toString('utf8'))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Which changed files the index does not describe, by their working-tree
 * content hashes. See the header for the files the check covers and its limits.
 * `root` is the project root.
 */
export function checkIndexCurrency(root: string, files: readonly FreshnessFile[]): IndexCurrency {
  const absRoot = path.resolve(root);
  const wanted = files.filter((f) => f.status !== 'deleted' && isInsideRoot(f.path)).map((f) => f.path);
  const none: IndexCurrency = { unsynced: [] };
  if (wanted.length === 0) return none;

  // Files with a `files` row, and the hash the index holds for each.
  const stored = new Map<string, string>();
  const conn = DatabaseConnection.open(getDatabasePath(absRoot), { readOnly: true });
  try {
    const select = conn.getDb().prepare('SELECT content_hash FROM files WHERE path = ?');
    for (const rel of wanted) {
      const row = select.get(rel) as { content_hash: string } | undefined;
      if (row) stored.set(rel, row.content_hash);
    }
  } finally {
    conn.close();
  }

  // Of those, the ones still on disk (a followed symlink counts, a dangling one does not).
  const present = [...stored.keys()].filter((rel) => fs.existsSync(path.join(absRoot, rel)));
  if (present.length === 0) return none;

  const unsynced: string[] = [];
  for (const rel of present) {
    const hash = indexedHashOf(path.join(absRoot, rel));
    if (hash !== null && hash !== stored.get(rel)) unsynced.push(rel);
  }
  return { unsynced };
}

/** "3 files" or "1 file", then up to LISTED_PATHS paths and "and N more". */
function listPaths(paths: readonly string[]): string {
  const listed = paths.slice(0, LISTED_PATHS).join(', ');
  const more = paths.length > LISTED_PATHS ? `, and ${paths.length - LISTED_PATHS} more` : '';
  return `${paths.length} ${paths.length === 1 ? 'file' : 'files'}: ${listed}${more}`;
}

/** The failure text naming the unsynced files and what to do, or null when none are found. */
export function currencyFailure(currency: IndexCurrency): string | null {
  if (currency.unsynced.length === 0) return null;
  return `✗ the index has not caught up with ${listPaths(currency.unsynced)}. ` +
    'Let it sync (or run `codegraph sync`) and run again.';
}
