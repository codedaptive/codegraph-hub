/**
 * The signal half of stopServer (src/mcp/server-control.ts): what happens to a
 * server whose lock record has already been proven by the daemon proof.
 */
import * as fs from 'fs';
import { getServerSocketCandidates } from '../../../mcp/daemon-paths';
import { removeLockIfUnchanged, snapshotLock } from '../../../mcp/lock-takeover';

/**
 * Stop the proven server `pid`, whose record in `pidPath` read `provenRaw` when
 * it was proven. The proof awaited I/O, so the record is read again first: gone
 * or changed is `unverified` and nothing is signalled. Otherwise SIGTERM, then
 * wait up to `waitMs` for the pid to go: `still-running` if it has not (never
 * escalated to SIGKILL), else the sweep ({@link sweepStoppedServer}) and
 * `stopped`. `isAlive` is the caller's liveness probe, passed in so this file
 * does not import server-control.
 */
export async function signalProvenServer(
  pid: number,
  pidPath: string,
  provenRaw: string,
  waitMs: number,
  isAlive: (pid: number) => boolean,
): Promise<'stopped' | 'still-running' | 'unverified'> {
  if (snapshotLock(pidPath)?.raw !== provenRaw) return 'unverified';
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  if (!await waitForDeath(pid, waitMs, isAlive)) return 'still-running';
  sweepStoppedServer(pidPath, provenRaw);
  return 'stopped';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForDeath(pid: number, timeoutMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}

/**
 * Remove what a stopped server left behind, when the lock is still the record
 * that was stopped. A server removes its own lock and socket on a graceful exit;
 * this covers one that could not (Windows, where SIGTERM is TerminateProcess).
 * Sockets go BEFORE the lock, so no successor can take the lock and bind a
 * socket this sweep then removes; a lock that changed meanwhile is a
 * successor's and everything stays.
 */
function sweepStoppedServer(pidPath: string, stoppedRaw: string): void {
  try {
    const left = snapshotLock(pidPath);
    if (left === null || left.raw !== stoppedRaw) return;
    // POSIX sockets are real files; Windows named pipes vanish with the process.
    if (process.platform !== 'win32') {
      for (const candidate of getServerSocketCandidates()) {
        try { fs.unlinkSync(candidate); } catch { /* gone */ }
      }
    }
    removeLockIfUnchanged(pidPath, left);
  } catch {
    /* best effort: the next server start clears a stale lock itself */
  }
}
