/**
 * The cold build of a root's index (a git worktree, or a directory outside git
 * with no index): a job of the index builder (src/extensions/host/builder/),
 * queued by `seed.ts` when a tool call names a root that has no index and, for
 * a worktree, no indexed sibling to copy one from.
 * {@link runColdBuild} holds the root's `rebuild.pid` from before the database
 * exists until the index is complete or removed, so no reader opens a
 * half-built index: every engine and daemon refuses to open a project while
 * another live process holds that lock (`assertNoRebuild`), and answers that
 * refusal as guidance.
 *
 * `codegraph init` itself is not reused: it creates the schema before it marks
 * the index as being built and takes no `rebuild.pid`, so for a moment a
 * reader would see an initialized, empty index.
 *
 * A root this builds gets a fresh seed nonce written into its database
 * and is registered in the project registry SEEDED, with that nonce and its
 * git common dir (as ./git.ts spells it), before `rebuild.pid` is released: an index
 * CodeGraph built on its own is reclaimed by the housekeeping teardown once
 * the worktree is removed (outside git, once its directory is gone), exactly
 * like a seeded one, and only while the
 * database at the path is still that one (project-registry.ts). A root
 * someone else indexed meanwhile is not registered (that index is theirs).
 *
 * Return codes of {@link runColdBuild}: 0 built (or already indexed by someone
 * else), 1 failed (the database it made is removed, so the root reads as not
 * indexed again; an index another initializer made meanwhile is left alone,
 * see runColdBuild), 3 another live process holds `rebuild.pid`. A builder
 * killed mid-build leaves its partial database and a `rebuild.pid` naming a
 * dead pid, and what the next builder does depends on the root:
 *   - a git worktree's index is judged abandoned (`isAbandonedIndex`, seed.ts,
 *     which requires a `.git` entry at the root): a later call for that root
 *     that seeds or rebuilds it discards both and builds again;
 *   - a plain directory's is never judged abandoned: the builder's service
 *     holds the partial database like any index, recovers it and reconciles it
 *     with a full catch-up, and reads may be answered from it before that
 *     catch-up ends.
 * The job itself ({@link BuilderSeedHost.queueColdBuild}) runs `admitColdBuild`
 * (seed.ts) right before this function, so a root that changed while the job
 * waited is not built; this function takes the root as it is given.
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
 * Write a fresh seed nonce into the database this build just made
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
 * this build holds it), but not a user's `codegraph init`, which takes no
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
    await coldBuildTestDelay();
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

/**
 * Test knob, read here only: `CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS` makes a
 * cold build wait that many milliseconds after it took `rebuild.pid` and
 * before it creates the database. The gates (__tests__/extensions/host/
 * index-builder.gate.test.ts) use it to hold a cold build open long enough to
 * sample its locks, queue more work behind it, or kill the builder inside it.
 * Unset, empty or not a positive number: no wait. Production never sets it.
 */
async function coldBuildTestDelay(): Promise<void> {
  const ms = Number(process.env.CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
