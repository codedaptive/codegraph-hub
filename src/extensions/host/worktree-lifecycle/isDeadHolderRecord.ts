/**
 * Whether the holder named by an existing `rebuild.pid` is gone, judged the
 * way `tryAcquireWriterLock` (src/mcp/writer-lock.ts) judges a lock it will
 * reclaim. `record` is that file as `readWriterLock` decoded it: null for an
 * unreadable record, a foreign one or one whose pid was reused, and those count
 * as dead. A pid of zero or below is dead without asking `alive`. `selfPid`
 * (this process re-acquiring its own slot) is never dead, whatever `alive`
 * says; any other pid is dead only when `alive` says it is not running.
 */
export function isDeadHolderRecord(
  record: { pid: number } | null,
  selfPid: number,
  alive: (pid: number) => boolean,
): boolean {
  if (record === null || record.pid <= 0) return true;
  return record.pid !== selfPid && !alive(record.pid);
}
