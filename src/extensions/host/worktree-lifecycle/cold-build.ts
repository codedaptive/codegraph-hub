/**
 * Child entry for the cold build of a git worktree's index, started by
 * `seed.ts`.
 *
 *   node --liftoff-only cold-build.js <worktree root>
 *
 * Spawned detached when a tool call names a worktree that has no index, no
 * indexed sibling to copy one from, and the user opted in to building it. It
 * holds the root's `rebuild.pid` from before the database exists until the
 * index is complete or removed, so no reader opens a half-built index: every
 * engine and daemon refuses to open a project while another live process holds
 * that lock (`assertNoRebuild`), and answers that refusal as guidance.
 *
 * `codegraph init` itself is not reused: it creates the schema before it marks
 * the index as being built and takes no `rebuild.pid`, so for a moment a
 * reader would see an initialized, empty index.
 *
 * A root this child built gets a fresh seed nonce written into its database
 * and is registered in the project registry SEEDED, with that nonce and its
 * git common dir (as ./git.ts spells it), before `rebuild.pid` is released: an index
 * CodeGraph built on its own is reclaimed by the housekeeping teardown once
 * the worktree is removed, exactly like a seeded one, and only while the
 * database at the path is still that one (project-registry.ts). A root
 * someone else indexed meanwhile is not registered (that index is theirs).
 *
 * Exit status: 0 built (or already indexed by someone else), 1 failed (the
 * database it made is removed, so the root reads as not indexed again; an
 * index another initializer made meanwhile is left alone, see runColdBuild), 2
 * usage (no root given), 3 another live process holds `rebuild.pid`. A child
 * killed by a signal leaves its partial database and a `rebuild.pid` naming a
 * dead pid; the server discards both on a later call for that root that seeds
 * or rebuilds it (seed.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../index';
import { getCodeGraphDir, isInitialized, statInode } from '../../../directory';
import { gitCommonDirAsync } from './git';
import { registerProject, stampSeedNonce } from './project-registry';
import { releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';

export const COLD_BUILD_EXIT_BUILT = 0;
export const COLD_BUILD_EXIT_FAILED = 1;
export const COLD_BUILD_EXIT_BUSY = 3;

/**
 * Write a fresh seed nonce into the database this child just built
 * (`dbFile`), then register the root as SEEDED with that nonce and its git
 * common dir (canonical, see ./git.ts; null outside a repository, when teardown can only
 * judge it by its directory). Best-effort: an unwritable registry leaves the
 * index built, only not reclaimed by teardown, and does not fail the build;
 * a nonce that could not be written is not recorded, and a record without
 * one never lets teardown delete the index.
 */
async function registerColdBuilt(root: string, dbFile: string): Promise<void> {
  let seedNonce: string | undefined;
  try {
    seedNonce = stampSeedNonce(dbFile);
  } catch (err) {
    process.stderr.write(`[CodeGraph] Could not mark the cold-built index of ${root} as CodeGraph's: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  try {
    registerProject(root, { seeded: true, commonDir: await gitCommonDirAsync(root), seedNonce });
  } catch (err) {
    process.stderr.write(`[CodeGraph] Could not register the cold-built index of ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Whether the database at `dbFile` is still the one `CodeGraph.init`
 * returned a handle on, identified then as `created` ({@link statInode}'s
 * exact `dev:ino`). POSIX compares the two. Windows reports no usable inode
 * (`created` is null there); the handle kept the file open until the close
 * just before this check, and Windows refuses to delete or replace a file
 * SQLite holds open, so no other initializer can have put its own database at
 * the path meanwhile: the file there, if any, is still this call's. A null
 * `created` on POSIX (the stat failed) proves nothing, so it never matches.
 */
function isCreatedDatabase(dbFile: string, created: string | null): boolean {
  if (created !== null) return statInode(dbFile) === created;
  return process.platform === 'win32' && fs.existsSync(dbFile);
}

/**
 * Build `root`'s index under its `rebuild.pid`. On failure only a database
 * this call created is removed: the one `CodeGraph.init` returned a handle on,
 * and only while that same file is still the one at the path
 * ({@link isCreatedDatabase}). `rebuild.pid` fences readers, seeders and a
 * user's `codegraph index` (which takes it too, and so refuses to run while
 * this child holds it), but not a user's `codegraph init`, which takes no
 * `rebuild.pid`: one may create the index after the check below and before
 * init's own check (init awaits the grammar load first), and init then
 * throws without creating anything. That index, or one that lands while init
 * fails for another reason, is the user's and stays. So does a file init left
 * behind when it threw after creating it: with no handle returned, nothing
 * proves it is this call's rather than that other initializer's.
 */
export async function runColdBuild(root: string): Promise<number> {
  const lock = tryAcquireWriterLock(root, 'cold-build', 'rebuild.pid');
  if (lock.kind === 'taken') return COLD_BUILD_EXIT_BUSY;
  let cg: CodeGraph | null = null;
  let ok = false;
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  // Set once init has returned: it created the database at dbFile, whose
  // identity (null where the platform has no inode) is `created`.
  let initReturned = false;
  let created: string | null = null;
  try {
    // A seed or a `codegraph init` may have landed between the decision and now.
    if (isInitialized(root)) {
      ok = true;
      return COLD_BUILD_EXIT_BUILT;
    }
    cg = await CodeGraph.init(root, { index: false });
    initReturned = true;
    created = statInode(dbFile);
    const result = await cg.indexAll();
    ok = result.success;
    if (ok) await registerColdBuilt(root, dbFile);
    return ok ? COLD_BUILD_EXIT_BUILT : COLD_BUILD_EXIT_FAILED;
  } catch (err) {
    process.stderr.write(`[CodeGraph] Cold build of ${root} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return COLD_BUILD_EXIT_FAILED;
  } finally {
    try { cg?.close(); } catch { /* already closed */ }
    if (!ok && initReturned && isCreatedDatabase(dbFile, created)) {
      // Ours, and still under rebuild.pid: no reader or seeder has opened it.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best-effort */ }
      }
    }
    releaseWriterLock(root, 'rebuild.pid');
  }
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('usage: cold-build.js <worktree root>\n');
    process.exit(2);
  }
  // indexAll has destroyed its parse-worker pool before it returns, so no
  // worker thread is alive to be torn down by this exit (worker-teardown.ts).
  void runColdBuild(root).then((code) => process.exit(code));
}
