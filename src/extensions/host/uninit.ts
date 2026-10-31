/**
 * `codegraph uninit`: the machine server and its index builder let go of the project's index before the CLI
 * deletes it.
 *
 * A running server keeps SQLite handles on every project it has answered for, and its builder holds the project
 * (a writable open, a watcher). Deleting `.codegraph` under them leaves the deleted `codegraph.db` open in both
 * processes for as long as they run, and lets the builder's catch-up or a session's call recreate files in a
 * directory that is going away. So the delete happens under a release, in one of two ways:
 *
 *   - Routed: a machine server with its builder up ({@link builderRoute}). The `release` request of
 *     codegraph/indexWrite (./builder/cli-wire.ts) fences the root (no builder job opens it from then on), has the server and the
 *     builder let go of it, waits for the root's running builder jobs, and answers; the CLI deletes; then `codegraph/indexWriteEnd` ends the fence. The server's own
 *     lease-ending when the connection goes covers a CLI that dies in between. The release arrives while
 *     `.codegraph` still exists and the end after it is gone, which is the order that closes the handles
 *     before the files go.
 *   - Not routed (no server, or one whose builder is not up): the guard `codegraph index` runs in its own
 *     process. `rebuild.pid` is taken (a running index rebuild refuses the uninit), the server, if one answers, is
 *     asked to release the root (`requestProjectRelease`) and a server that did not confirm refuses it, because
 *     it may still hold the database. No server running goes straight on. Nothing is started and no
 *     `server.pid` or `builder.pid` is written. `writer.pid` is not taken: `rebuild.pid` alone keeps readers off the
 *     index, and nothing is recreated or indexed here.
 *
 * The deletion itself is the caller's `remove`: it opens the index and calls `CodeGraph.uninitialize`. Routed, it
 * opens read-only, so the CLI runs no migration or repair on an index it is about to delete; not routed it opens
 * as the command always did. Output and exit codes are the command's, on both paths: a refusal is an `Error` the
 * command's catch prints as "Failed to uninitialize: <message>".
 *
 * Loaded only with `await import`, by the `uninit` action in src/bin/codegraph.ts, so registering the command
 * loads neither this module nor the engine.
 */
import * as fs from 'fs';
import { requestProjectRelease } from '../../mcp/server-control';
import { releaseWriterLock, tryAcquireWriterLock } from '../../mcp/writer-lock';
import { REBUILD_IN_PROGRESS_MESSAGE } from './builder/fences';
import { builderRoute } from './builder/cli-route';

/** Deletes the project's index. `readOnly`: open it read-only (the routed path; the CLI migrates nothing it deletes). */
export type RemoveIndex = (readOnly: boolean) => void | Promise<void>;

/**
 * Runs `remove` with the server and the builder having let go of `projectPath`'s index (an absolute path), as the
 * module comment describes, and ends the hold afterwards, also when `remove` throws. Rejects with the refusal or
 * the failure; a `remove` that rejects may already have deleted part of the index.
 */
export async function removeIndexReleased(projectPath: string, remove: RemoveIndex): Promise<void> {
  const route = await builderRoute();
  if (route !== null) {
    let answer: Awaited<ReturnType<typeof route.release>>;
    try {
      answer = await route.release(projectPath);
    } catch (err) {
      // A refusal (another rebuild is running) or a lost connection: the server took no lease, or drops it with the
      // connection. Nothing was deleted.
      route.close();
      throw err;
    }
    if (answer.routed) {
      try {
        await remove(true);
      } finally {
        // The files are gone, or the delete failed and the index stays: either way the fence ends. The builder's
        // release of rebuild.pid finds it gone when the directory went, and removes it when the delete failed.
        await route.end(projectPath);
        route.close();
      }
      return;
    }
    // The server's builder is not up: nothing was fenced or released. The guard below asks the server itself.
    route.close();
  }

  const rebuild = tryAcquireWriterLock(projectPath, 'rebuild', 'rebuild.pid');
  if (rebuild.kind === 'taken') throw new Error(REBUILD_IN_PROGRESS_MESSAGE);
  try {
    const realRoot = fs.realpathSync(projectPath);
    const released = await requestProjectRelease(realRoot);
    if (released === 'failed') {
      throw new Error(
        `The CodeGraph server did not confirm that it released ${realRoot}, so it may still hold the database open. ` +
        'Stop it with `codegraph daemon --stop`, then retry `codegraph uninit`.',
      );
    }
    await remove(false);
  } finally {
    // Deleted with the directory when the uninit succeeded; released here when it did not.
    releaseWriterLock(projectPath, 'rebuild.pid');
  }
}
