/**
 * The cold build of a git worktree root's index: a job of the index builder
 * (src/extensions/host/builder/), queued by `seed.ts` when a tool call names a
 * worktree that has no index and no indexed sibling to copy one from.
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
 * the worktree is removed, exactly like a seeded one, and only while the
 * database at the path is still that one (project-registry.ts). A root
 * someone else indexed meanwhile is not registered (that index is theirs).
 *
 * Return codes of {@link runColdBuild}: 0 built (or already indexed by someone
 * else), 1 failed, 3 another live process holds `rebuild.pid`, 4 a retryable
 * SQLite lock thrown by indexAll or reported in its errors, or thrown by init
 * with no database file at dbFile. On 1 or 4, removal of this build's database
 * is best-effort and only if its identity still matches; see runColdBuild.
 * The builder runs each attempt in its own child process (builder/cold-build-body.ts). A child the builder
 * ends at a job limit or after its stop's grace is killed, and its partial work is rolled back at once
 * (builder/clean-up-ended-job.ts): when the child had reported its database (init returned), the database is
 * removed only when it is this build's by that identity; when it had reported none (killed during init), it is
 * discarded as ./discardDeadColdBuildLeftover.ts does, unless another live process holds `writer.pid`; either
 * way the `rebuild.pid` naming the child is released. A build killed with its builder leaves its `rebuild.pid`
 * naming a dead pid with mode `cold-build`. Such a leftover is discarded thus:
 *   - the next cold build of that root reads the dead cold build's record
 *     (./deadColdBuildHolder.ts) before it takes the lock over, and then
 *     discards whatever database is at the path (./discardDeadColdBuildLeftover.ts),
 *     with or without the schema, before it checks whether the root is indexed;
 *   - a git worktree's index is judged abandoned (`isAbandonedIndex`, seed.ts,
 *     which requires a `.git` entry at the root): a later call for that root
 *     that seeds or rebuilds it discards both and builds again;
 *   - after any other dead holder (a `codegraph index` lease's record has mode
 *     `rebuild`), only a database without the schema is discarded before init
 *     (./discardSchemalessLeftover.ts);
 *   - a root outside git is never cold-built (`admitColdBuild`, seed.ts), so it
 *     has no killed build's partial database to judge.
 * The job itself (builder/cold-build-job.ts) refuses a root whose cold build was ended over a job limit, and
 * runs `admitColdBuild` (seed.ts) before each attempt to reject a root that no longer passes admission
 * after queueing or a retry delay; this function takes the root as it is given.
 */
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../index';
import { getCodeGraphDir, isInitialized, statInode } from '../../../directory';
import { gitCommonDirAsync } from './git';
import { registerProject, stampSeedNonce } from './project-registry';
import { releaseWriterLock, tryAcquireWriterLock } from '../../../mcp/writer-lock';
import { coldBuildDatabases } from './cold-build-database';
import { deadColdBuildHolder } from './deadColdBuildHolder';
import { deadRebuildHolder } from './deadRebuildHolder';
import { discardDeadColdBuildLeftover } from './discardDeadColdBuildLeftover';
import { discardSchemalessLeftover } from './discardSchemalessLeftover';

export const COLD_BUILD_EXIT_BUILT = 0;
export const COLD_BUILD_EXIT_FAILED = 1;
export const COLD_BUILD_EXIT_BUSY = 3;
export const COLD_BUILD_EXIT_LOCKED = 4;

/** SQLite can wrap a lock in a cause or report an extended SQLITE_BUSY code. */
function isSqliteLock(error: unknown): boolean {
  while (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string' && /database is locked/i.test(error.message)) return true;
    // The low byte is the primary result code; 5 is SQLITE_BUSY.
    if ('errcode' in error && typeof error.errcode === 'number' && (error.errcode & 0xff) === 5) return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

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
 * Build `root`'s index under its `rebuild.pid`. On failure only a database
 * this call created is removed, besides a dead build's leftover discarded
 * before init (below): the one `CodeGraph.init` returned a handle on,
 * and only while that same file is still the one at the path
 * (`coldBuildDatabases.isOurs`, ./cold-build-database.ts, where this call
 * registers it from init's return until it ends). `rebuild.pid` fences readers, seeders and a
 * user's `codegraph index` (which takes it too, and so refuses to run while
 * this build holds it), but not a user's `codegraph init`, which takes no
 * `rebuild.pid`: one may create the index after the check below and before
 * init's own check (init awaits the grammar load first), and init then
 * throws without creating anything. That index, or one that lands while init
 * fails for another reason, is the user's and stays. So does a file init left
 * behind when it threw after creating it: with no handle returned, nothing
 * proves it is this call's rather than that other initializer's. A SQLite lock
 * thrown by indexAll or reported in its errors returns LOCKED, as does one thrown
 * by init with no file left at dbFile. On an indexAll lock, removal of the
 * created database is best-effort and subject to the identity check above.
 * An init lock leaving a file returns FAILED; registration errors are handled
 * best-effort, not returned as LOCKED. A held rebuild.pid returns BUSY.
 *
 * One database this call did not create is removed, unless another live
 * process holds `writer.pid`: when the `rebuild.pid` it took over named a dead
 * cold build (./deadColdBuildHolder.ts), whatever database is at the path is
 * that build's leftover and is discarded first (./discardDeadColdBuildLeftover.ts);
 * when it named another dead holder (./deadRebuildHolder.ts), a database
 * without the schema is discarded before init (./discardSchemalessLeftover.ts),
 * unless the file is not SQLite. With no `rebuild.pid` in place (a user's own
 * `codegraph init`, say) such a database stays, and init fails on it.
 */
export async function runColdBuild(root: string): Promise<number> {
  const afterDeadHolder = deadRebuildHolder(root);
  const afterDeadColdBuild = deadColdBuildHolder(root);
  const lock = tryAcquireWriterLock(root, 'cold-build', 'rebuild.pid');
  if (lock.kind === 'taken') return COLD_BUILD_EXIT_BUSY;
  let cg: CodeGraph | null = null;
  let ok = false;
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  // Only these engine steps can make a failure retryable, not registration or bookkeeping.
  let step: 'init' | 'indexAll' | null = null;
  try {
    await coldBuildTestDelay();
    // Before the check below: a dead cold build's database may carry the schema without being a built index.
    if (afterDeadColdBuild) discardDeadColdBuildLeftover(root);
    // A seed or a `codegraph init` may have landed between the decision and now.
    if (isInitialized(root)) {
      ok = true;
      return COLD_BUILD_EXIT_BUILT;
    }
    discardSchemalessLeftover(root, afterDeadHolder);
    step = 'init';
    cg = await CodeGraph.init(root, { index: false });
    step = null;
    // Init returned: it created the database at dbFile, registered by its
    // identity (null where the platform has no inode).
    coldBuildDatabases.set(root, statInode(dbFile));
    step = 'indexAll';
    const result = await cg.indexAll();
    step = null;
    ok = result.success;
    if (result.success === false && result.errors?.some((error) => /database is locked/i.test(error.message))) {
      process.stderr.write(`[CodeGraph] Cold build of ${root} failed: database is locked\n`);
      return COLD_BUILD_EXIT_LOCKED;
    }
    if (ok) await registerColdBuilt(root, dbFile);
    return ok ? COLD_BUILD_EXIT_BUILT : COLD_BUILD_EXIT_FAILED;
  } catch (err) {
    const locked = step !== null && isSqliteLock(err);
    process.stderr.write(`[CodeGraph] Cold build of ${root} failed${locked ? ' (database is locked)' : ''}: ${err instanceof Error ? err.message : String(err)}\n`);
    if (locked && (step === 'indexAll' || !fs.existsSync(dbFile))) return COLD_BUILD_EXIT_LOCKED;
    return COLD_BUILD_EXIT_FAILED;
  } finally {
    try { cg?.close(); } catch { /* already closed */ }
    if (!ok && coldBuildDatabases.isOurs(root, dbFile)) {
      // Ours, and still under rebuild.pid: no reader or seeder has opened it.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best-effort */ }
      }
    }
    coldBuildDatabases.clear(root);
    releaseWriterLock(root, 'rebuild.pid');
  }
}

/**
 * Test knob, read here only: `CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS` makes a
 * cold build wait that many milliseconds after it took `rebuild.pid` and
 * before it creates the database. The validation tests (__tests__/extensions/host/
 * index-builder.validation.test.ts) use it to hold a cold build open long enough to
 * sample its locks, queue more work behind it, or kill the builder inside it.
 * Unset, empty or not a positive number: no wait. Production never sets it.
 */
async function coldBuildTestDelay(): Promise<void> {
  const ms = Number(process.env.CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
