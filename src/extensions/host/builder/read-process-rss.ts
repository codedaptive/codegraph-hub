/**
 * The resident size of another process, read from outside it (the watchdog, ./job-watchdog.ts, reads each job's
 * child this way): `VmRSS` in `/proc/<pid>/status` on Linux, the memory column of
 * `tasklist /FI "PID eq <pid>" /FO CSV /NH` on Windows, `ps -o rss= -p <pid>` elsewhere. All three report KiB.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';

const KIB = 1024;
/**
 * A hung `ps` or `tasklist` must not stop every later sample: the watchdog skips a sample while one is in flight, so
 * a read that never answered would leave every job unwatched. 5 s is far past a healthy read. A timed-out read is
 * null. windowsHide keeps each call from flashing a console window on Windows.
 */
const EXEC_OPTIONS = { timeout: 5_000, windowsHide: true };

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
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], EXEC_OPTIONS, (err, stdout) => {
      const kib = stdout.trim();
      resolve(err || !/^\d+$/.test(kib) ? null : Number(kib) * KIB);
    });
  });
}

/**
 * The KiB in `pid`'s row of tasklist's CSV output, or null. Each field is quoted and the memory field carries the
 * locale's thousands separator ("45,678 K" or "45.678 K"), so fields split on `","` and the memory keeps its digits
 * only. When nothing matches, tasklist prints an `INFO:` line instead of a row.
 */
function tasklistKib(stdout: string, pid: number): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().replace(/^"|"$/g, '').split('","');
    if (fields[1] !== String(pid) || fields[4] === undefined) continue;
    const digits = fields[4].replace(/\D/g, '');
    return digits === '' ? null : Number(digits);
  }
  return null;
}

function readTasklist(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], EXEC_OPTIONS, (err, stdout) => {
      const kib = err ? null : tasklistKib(stdout, pid);
      resolve(kib === null ? null : kib * KIB);
    });
  });
}

/** `pid`'s resident size in bytes; null when it cannot be read or the process is gone. */
export function readProcessRssBytes(pid: number): Promise<number | null> {
  switch (process.platform) {
    case 'linux':
      return readLinux(pid);
    case 'win32':
      return readTasklist(pid);
    default:
      return readPs(pid);
  }
}
