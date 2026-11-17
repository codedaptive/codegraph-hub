/**
 * The database each running cold build (./cold-build.ts) created, by root, so the build's own failure path and
 * the builder's job-limit exit (../builder/job-limit-guard.ts) remove a database only when it is that build's.
 * A root is registered once `CodeGraph.init` has returned, with the identity of the file it created, and
 * cleared when the build ends; roots compare by their canonical spelling.
 */
import * as fs from 'fs';
import { canonicalProjectRoot, statInode } from '../../../directory';

/** Each running build's `created` identity ({@link statInode}'s `dev:ino`; null where the platform has none). */
const createdByRoot = new Map<string, string | null>();

export const coldBuildDatabases = {
  /** Records that the cold build of `root` created the database whose identity is `created`. */
  set(root: string, created: string | null): void {
    createdByRoot.set(canonicalProjectRoot(root), created);
  },
  clear(root: string): void {
    createdByRoot.delete(canonicalProjectRoot(root));
  },
  /**
   * Whether the database at `dbFile` is the one the running cold build of `root` created: false when no build
   * of `root` has registered one. POSIX compares the file's identity now with `created`. Windows reports no
   * usable inode (`created` is null there); the build's handle kept the file open, and Windows refuses to
   * delete or replace a file SQLite holds open, so no other initializer can have put its own database at the
   * path meanwhile: the file there, if any, is still the build's. A null `created` on POSIX (the stat failed)
   * proves nothing, so it never matches.
   */
  isOurs(root: string, dbFile: string): boolean {
    const key = canonicalProjectRoot(root);
    if (!createdByRoot.has(key)) return false;
    const created = createdByRoot.get(key) ?? null;
    if (created !== null) return statInode(dbFile) === created;
    return process.platform === 'win32' && fs.existsSync(dbFile);
  },
};
