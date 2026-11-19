/**
 * The full rebuild of an initialized root, as `codegraph index` runs it (src/bin/codegraph.ts) and as an explicit
 * `codegraph init` of a root the index builder stopped at a limit runs it (./retryStoppedInit.ts). The caller passes
 * `runIndexOn`, the CLI's supervised, progress-rendered index (it destroys the writer it is given and answers
 * whether the index succeeded), and `loadEngine`, its engine loader, so a module that fails to load is reported
 * as the CLI reports it. Throws when another rebuild holds the root, another process holds its writer lock, or a running
 * server did not release it.
 */
import * as fs from 'node:fs';
import type { IndexWriter } from './builder/cli-route';
import { clearEndedRoot } from './builder/clear-ended-root';
import { unprovenReleaseRefusal } from './unprovenReleaseRefusal';

export async function rebuildIndex(
  projectPath: string,
  options: { force?: boolean; quiet?: boolean; verbose?: boolean; yes?: boolean },
  deps: {
    runIndexOn: (writer: IndexWriter, dbPath: string, projectPath: string, options: { quiet?: boolean; verbose?: boolean; yes?: boolean }) => Promise<boolean>;
    loadEngine: () => Promise<typeof import('../../index')>;
  },
): Promise<boolean> {
  // With a machine server whose index builder is up, the builder rebuilds the index under a lease it holds
  // for this command, and this process takes no lock. Otherwise this process rebuilds, below.
  const routed = await (await import('./builder/cli-route')).startRoutedIndex(projectPath, !!options.force, !!options.verbose && !options.quiet);
  if (routed) {
    try {
      const { getDatabasePath } = await deps.loadEngine();
      return await deps.runIndexOn(routed, getDatabasePath(projectPath), projectPath, options);
    } finally {
      await routed.end();
    }
  }

  const { tryAcquireWriterLock, releaseWriterLock, writerLockHeldMessage } = await import('../../mcp/writer-lock');
  const rebuild = tryAcquireWriterLock(projectPath, 'rebuild', 'rebuild.pid');
  if (rebuild.kind === 'taken') throw new Error('Another index rebuild is already in progress.');
  try {
    // The machine server keeps SQLite handles open on every project it has
    // answered for. Ask it to release this one (it keeps serving every other
    // project and reopens this one on its next call); never stop it. No server
    // running, or one that released the project, goes on to the writer lock. A
    // server that did not confirm may still hold the database, so the rebuild
    // would delete files under it: refuse instead.
    const { requestProjectRelease } = await import('../../mcp/server-control');
    const realRoot = fs.realpathSync(projectPath);
    let failedSocket = '';
    const released = await requestProjectRelease(realRoot, undefined, (socketPath) => { failedSocket = socketPath; });
    if (released === 'failed') throw new Error(unprovenReleaseRefusal(realRoot, failedSocket, '`codegraph index`'));

    // Keep the writer slot through recreation AND indexing. A reconnecting
    // proxy/server must not open the replacement database halfway through.
    const writer = tryAcquireWriterLock(projectPath, 'rebuild');
    if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
    try {
      const { default: CodeGraph, getDatabasePath } = await deps.loadEngine();
      // A rebuild is a FULL re-index — identical to a fresh `init`. RECREATE the
      // database from scratch (discard .codegraph/codegraph.db + its WAL) rather
      // than opening the old graph and DELETE-ing every row. The clear-then-index
      // approach reported "0 nodes" without the clear (#874); the recreate keeps
      // that fixed AND avoids the failure mode where, on a large or pre-fix
      // poisoned index, the per-row FTS delete churn wedged the main thread long
      // enough to trip the liveness watchdog before scanning even began (#1067).
      // recreate() hands back a fresh, empty instance — no clear() needed. For
      // fast incremental updates use `sync`.
      const cg = await CodeGraph.recreate(projectPath);
      if (!(await deps.runIndexOn(cg, getDatabasePath(projectPath), projectPath, options))) return false;
      // The rebuild succeeded, so the root's stopped-over-limit marks go. A builder started while this ran
      // keeps its in-memory mark until it restarts.
      clearEndedRoot(projectPath);
      return true;
    } finally {
      releaseWriterLock(projectPath);
    }
  } finally {
    releaseWriterLock(projectPath, 'rebuild.pid');
  }
}
