/**
 * The resident size of another process, read from outside it (the watchdog, ./job-watchdog.ts, reads each job's
 * child this way): `VmRSS` in `/proc/<pid>/status` on Linux, `ps -o rss= -p <pid>` elsewhere. Both report KiB.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';

const KIB = 1024;
/**
 * A hung `ps` must not stop every later sample: the watchdog skips a sample while one is in flight, so a read that
 * never answered would leave every job unwatched. 5 s is far past a healthy `ps`. A timed-out read is null.
 */
const PS_TIMEOUT_MS = 5_000;

function readLinux(pid: number): Promise<number | null> {
  return fs.readFile(`/proc/${pid}/status`, 'utf8').then(
    (status) => {
      const kib = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kib === undefined ? null : Number(kib) * KIB;
    },
    () => null,
  );
}

function readPs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      const kib = stdout.trim();
      resolve(err || !/^\d+$/.test(kib) ? null : Number(kib) * KIB);
    });
  });
}

/** `pid`'s resident size in bytes; null when it cannot be read or the process is gone. */
export function readProcessRssBytes(pid: number): Promise<number | null> {
  return process.platform === 'linux' ? readLinux(pid) : readPs(pid);
}
