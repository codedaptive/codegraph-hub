/**
 * The parent pid of `pid`, read from outside it: `ps -o ppid=` on POSIX, the process's CIM record through
 * PowerShell on Windows (Windows has no `ps`). Null when the process is gone (ps exits non-zero; PowerShell prints
 * nothing) or the output is not a number.
 */
import { execFileSync } from 'child_process';

function readParent(pid: number): string {
  if (process.platform === 'win32') {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', windowsHide: true });
  }
  return execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
}

export function parentPid(pid: number): number | null {
  try {
    const out = readParent(pid).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}
