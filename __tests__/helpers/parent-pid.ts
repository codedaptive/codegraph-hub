/**
 * The parent pid of `pid`, read from outside it: `ps -o ppid=` on POSIX, the process's CIM record through
 * PowerShell on Windows (Windows has no `ps`). Null only when the process is gone: on POSIX ps exits non-zero
 * with nothing on stdout, on Windows PowerShell prints nothing. Any other failure throws (a missing ps or
 * PowerShell, ps failing with output, output that is not a pid), so a broken probe is never read as "gone".
 */
import { execFileSync } from 'child_process';

function readPosixParent(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    if (err instanceof Error && 'status' in err && typeof err.status === 'number' && err.status !== 0
      && 'stdout' in err && String(err.stdout).trim() === '') return '';
    throw err;
  }
}

function readParent(pid: number): string {
  if (process.platform !== 'win32') return readPosixParent(pid);
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', windowsHide: true });
}

export function parentPid(pid: number): number | null {
  const out = readParent(pid).trim();
  if (out === '') return null;
  if (!/^\d+$/.test(out)) throw new Error(`parentPid(${pid}): not a pid: ${JSON.stringify(out)}`);
  return Number(out);
}
