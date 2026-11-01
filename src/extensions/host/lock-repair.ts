/**
 * `codegraph unlock`: take out the project's indexing lock when nothing holds it, and refuse when a process does.
 *
 * The one file it reads is `<root>/.codegraph/codegraph.lock`, the {@link FileLock} (src/utils.ts) that the
 * index writes take (`indexAll`, `indexFiles`, `sync`, `healSegmentVocabIfEmpty` in src/index.ts): line 1 is the
 * holder's pid, line 2 (when the holder wrote an owner record)
 * the JSON stamp `{root, dirId, dbId, pid, pidStart}`. `writer.pid` and `rebuild.pid` are not read here: the
 * commands that need them free say so themselves when one is held (`writerLockHeldMessage`, the rebuild refusal).
 *
 * The lock is judged stale by the rule FileLock.acquire applies, with one difference: an empty lock is stale here
 * at any age (its first line is not a pid), where FileLock holds one younger than its empty-lock grace because its
 * creator may still be writing the pid.
 *
 *   - the first line is not a pid above zero: stale (a pid of 0 or below is no process, and signal 0 to pid 0
 *     would address the caller's own process group);
 *   - the record on line 2 is foreign ({@link isForeignLockRecord}: its pid now names a process that started at
 *     another time, or it is another project's, copied in with its `.codegraph/`): stale, whatever its pid;
 *   - the pid is not running: stale;
 *   - otherwise a live process holds it. A pid the caller may not signal (EPERM) is running, so it holds.
 *
 * A stale lock is removed with {@link removeLockIfUnchanged} from the one {@link snapshotLock} that was judged,
 * under the takeover guard, so a lock another process created after the judgement is not deleted. Nothing here
 * prints or exits: the command owns the output and the exit status.
 *
 * Loaded only with `await import`, by the `unlock` action in src/bin/codegraph.ts.
 */
import * as path from 'path';
import { getCodeGraphDir } from '../../directory';
import { removeLockIfUnchanged, snapshotLock } from '../../mcp/lock-takeover';
import { isForeignLockRecord } from '../../mcp/writer-lock';

/** What {@link repairLock} did. `message` is the text the command prints for a refusal (exit 1). */
export type LockRepair =
  | { kind: 'none'; lockPath: string }
  | { kind: 'removed'; lockPath: string }
  | { kind: 'held'; lockPath: string; pid: number; message: string }
  | { kind: 'contended'; lockPath: string; message: string };

/** Signal-0 liveness; EPERM means the process exists and is not the caller's to signal, so it counts as running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/**
 * The pid of the live process that holds the lock whose bytes are `raw`, or null when nothing does (the lock is
 * stale). Parsed as FileLock.acquire parses it: `parseInt` of the first line, and the second line, unmodified, as
 * the owner record.
 */
function liveHolder(raw: string, projectRoot: string): number | null {
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const recordLine = raw.split('\n')[1];
  if (recordLine !== undefined) {
    try {
      if (isForeignLockRecord(JSON.parse(recordLine), projectRoot)) return null;
    } catch { /* a second line that is not JSON is no record: the pid decides */ }
  }
  return isRunning(pid) ? pid : null;
}

/**
 * Take `projectRoot`'s `codegraph.lock` out if it is stale. Throws what {@link snapshotLock} throws for a lock
 * that exists and cannot be read (a directory, no permission) and what the removal throws: the command reports
 * the error and exits 1, as it did for the failed unlink.
 */
export function repairLock(projectRoot: string): LockRepair {
  const lockPath = path.join(getCodeGraphDir(projectRoot), 'codegraph.lock');
  const snapshot = snapshotLock(lockPath);
  if (snapshot === null) return { kind: 'none', lockPath };

  const pid = liveHolder(snapshot.raw, projectRoot);
  if (pid !== null) {
    return { kind: 'held', lockPath, pid, message: `${lockPath} is held by a live process (pid ${pid}); nothing removed.` };
  }

  switch (removeLockIfUnchanged(lockPath, snapshot)) {
    case 'removed':
      return { kind: 'removed', lockPath };
    case 'gone':
      // Released between the read and the removal: there is nothing left to take out.
      return { kind: 'none', lockPath };
    case 'changed':
      return {
        kind: 'contended',
        lockPath,
        message: `${lockPath} changed while it was being checked, so a process may have taken it; nothing removed. Run \`codegraph unlock\` again.`,
      };
    case 'busy':
      return {
        kind: 'contended',
        lockPath,
        message: `${lockPath} is being taken over by another process; nothing removed. Run \`codegraph unlock\` again.`,
      };
  }
}
