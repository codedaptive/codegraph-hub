/**
 * What the OS says a running process is, for judging a lock file that names it
 * (#2770).
 *
 * A pid in a lock file proves nothing once the OS has given that number to
 * another process, and a server that does not answer its socket hello cannot
 * vouch for itself (#1553). The process's command line is the evidence left:
 * every CodeGraph server runs `<runtime> … codegraph.js serve --mcp`. A lock whose live holder runs anything else is as stale as one whose
 * holder has exited. When the OS withholds the command line (another user's or
 * an elevated process), the executable's name can still rule out a holder that
 * is no JavaScript runtime at all.
 *
 * Lookups are bounded and best-effort. What the OS won't say is `null`, and
 * `null` is never evidence either way: such a holder stays `unknown`, and its
 * lock is kept.
 *
 * The second kind of evidence is when a process started
 * ({@link processStartTime}). Every stamped lock record carries its writer's
 * start time beside its pid, where the OS gives one (`pidStart` in
 * `LockStamp`), so a reader
 * can tell the writer from a later process the OS gave the same pid: the pid
 * is alive but started at another time. That lookup is synchronous, because
 * the lock readers that need it are, and bounded the same way; what it cannot
 * read is `null`, and pid liveness alone then decides.
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ProcessDescription {
  /** The executable's file name, such as `node.exe` or `node`; null when the OS won't say. */
  name: string | null;
  /** The whole command line; null when the OS won't say. */
  commandLine: string | null;
}

/**
 * A live lock holder is a CodeGraph MCP server (`codegraph-server`), provably
 * something else (`other`), or a process the OS won't describe (`unknown`).
 */
export type LockHolderKind = 'codegraph-server' | 'other' | 'unknown';

const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How long one OS query may run: 5 s, unless `CODEGRAPH_PROCESS_LOOKUP_TIMEOUT_MS`
 * says otherwise. Tests set it: on a loaded machine PowerShell can take longer
 * than 5 s to start, and a Windows lookup that runs out falls back to tasklist,
 * which has no command line to show.
 */
function lookupTimeoutMs(): number {
  const fromEnv = Number(process.env.CODEGRAPH_PROCESS_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : LOOKUP_TIMEOUT_MS;
}

/** Runs a short OS query and resolves its stdout, or null when it fails or times out. */
function query(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', timeout: lookupTimeoutMs(), windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

function windowsTool(...parts: string[]): string {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', ...parts);
}

async function describeWindowsProcess(pid: number): Promise<ProcessDescription> {
  // Win32_Process has the command line; tasklist, the fallback when PowerShell
  // can't run, has only the image name.
  const script =
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    'if ($p) { [Console]::Out.Write((ConvertTo-Json -Compress @{ name = $p.Name; commandLine = $p.CommandLine })) }';
  const json = await query(windowsTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script]);
  if (json?.trim()) {
    try {
      const found = JSON.parse(json) as { name?: unknown; commandLine?: unknown };
      return {
        name: typeof found.name === 'string' && found.name ? found.name : null,
        commandLine: typeof found.commandLine === 'string' && found.commandLine.trim() ? found.commandLine : null,
      };
    } catch { /* fall back to tasklist */ }
  }
  const csv = await query(windowsTool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  for (const line of csv?.split(/\r?\n/) ?? []) {
    const fields = /^"([^"]*)","(\d+)"/.exec(line);
    if (fields && Number(fields[2]) === pid) return { name: fields[1] || null, commandLine: null };
  }
  return { name: null, commandLine: null };
}

function describeLinuxProcess(pid: number): ProcessDescription {
  let commandLine: string | null = null;
  let name: string | null = null;
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (args.length > 0) commandLine = args.join(' ');
  } catch { /* gone, or hidden (hidepid) */ }
  try {
    name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
  } catch { /* gone, or hidden */ }
  return { name, commandLine };
}

async function describePsProcess(pid: number): Promise<ProcessDescription> {
  const [args, comm] = await Promise.all([
    query('ps', ['-ww', '-o', 'args=', '-p', String(pid)]),
    query('ps', ['-o', 'comm=', '-p', String(pid)]),
  ]);
  return { name: comm?.trim() || null, commandLine: args?.trim() || null };
}

/** What the OS says process `pid` is running. Never throws. */
export async function describeProcess(pid: number): Promise<ProcessDescription> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { name: null, commandLine: null };
  if (process.platform === 'win32') return describeWindowsProcess(pid);
  if (process.platform === 'linux') return describeLinuxProcess(pid);
  return describePsProcess(pid);
}

/**
 * Whether a command line is a CodeGraph MCP server's, the only kind of process
 * that writes `server.pid`: it names CodeGraph and has `serve` and `--mcp` as
 * arguments.
 */
export function isCodeGraphServerCommandLine(commandLine: string): boolean {
  const args = commandLine.replace(/["']/g, ' ').split(/\s+/);
  return /codegraph/i.test(commandLine) && args.includes('serve') && args.some((a) => a === '--mcp' || a.startsWith('--mcp='));
}

/** Whether an executable could be a JavaScript runtime that runs CodeGraph. */
function mayRunCodeGraph(name: string): boolean {
  const base = path.basename(name.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  return /node|codegraph|bun|deno/.test(base);
}

/**
 * What a live lock holder is. The command line decides when the OS gives it;
 * otherwise only an executable that is no JavaScript runtime counts as `other`.
 */
export function classifyLockHolder(description: ProcessDescription): LockHolderKind {
  if (description.commandLine !== null) {
    return isCodeGraphServerCommandLine(description.commandLine) ? 'codegraph-server' : 'other';
  }
  if (description.name !== null && !mayRunCodeGraph(description.name)) return 'other';
  return 'unknown';
}

/**
 * How long one synchronous start-time query (`ps`) may run. The lock readers
 * that call it sit on the query path (every query checks `rebuild.pid`), so it
 * is bounded well below {@link LOOKUP_TIMEOUT_MS}; `ps` answers in a few
 * milliseconds on an idle machine. A query that runs out reads as unknown.
 */
const START_TIME_TIMEOUT_MS = 2_000;

/**
 * How long a start time read for ANOTHER process is reused. A live pid's start
 * time changes only when the pid is reused, which needs the process to exit
 * first, so a cached answer can at worst report a just-reused pid as its old
 * holder for this long: the lock is then reclaimed a moment later. A cached
 * answer must never be the evidence that a pid WAS reused (it may predate a
 * holder that took the pid since), so a caller that sees a mismatch re-reads
 * with `fresh` before acting on it. The cache bounds the `ps` spawns a busy
 * reader makes (during a rebuild every query reads `rebuild.pid`) to one per
 * pid per window.
 */
const START_TIME_CACHE_MS = 1_000;

/**
 * Entries kept at most; the cache is cleared whole past this, which costs only
 * re-reads. The bound keeps a long-lived server that has read many pids from
 * growing the map without limit; 64 is ample because a reader only ever asks
 * about the few holders named by the lock files of the projects it has open.
 */
const START_TIME_CACHE_MAX = 64;

const startTimeCache = new Map<number, { value: string | null; at: number }>();

/** This process's own start time, kept once known: it cannot change while it runs. Undefined until first read; null while unreadable. */
let ownStartTime: string | null | undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `ps -o lstart=` output, `Thu Oct 29 10:12:33 2026`, as ISO8601 UTC
 * (`2026-10-29T10:12:33Z`). The query runs with `TZ=UTC0` and `LC_ALL=C`, so
 * the text is UTC with English month names whatever the caller's environment,
 * and the conversion is exact: same second, no zone arithmetic. Null when the
 * text is not in that form.
 */
function lstartToIso(text: string): string | null {
  const m = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return `${m[6]}-${pad(String(month + 1))}-${pad(m[2]!)}T${m[3]}:${m[4]}:${m[5]}Z`;
}

/** macOS and the BSDs: `ps -o lstart=`, normalised to ISO8601 UTC. */
function psStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: START_TIME_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' },
    });
    return lstartToIso(out);
  } catch {
    return null; // no such pid (ps exits 1), no ps, or it ran out
  }
}

/**
 * Linux: the kernel's own record, as text `linux:<boot_id>:<starttime>`, where
 * `starttime` is field 22 of `/proc/<pid>/stat` (clock ticks after boot) and
 * `boot_id` is `/proc/sys/kernel/random/boot_id`, which names this boot.
 *
 * Not converted to a wall-clock date: that needs `btime` from `/proc/stat`,
 * and `btime` moves whenever the system clock is stepped (an NTP step, a
 * manual set, a resumed VM), so a live holder's converted start time would
 * change under it and its lock would look reused and be stolen. Ticks after
 * boot never move while the process lives, and the boot id keeps a record
 * written before a reboot from matching a process of the next boot that has
 * the same pid and tick count. Both are read without a spawn.
 */
function linuxStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (comm) is parenthesised and may hold spaces or parens: the
    // fields after it start past the LAST `)`, with field 3 first.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ticks = rest[22 - 3];
    if (!ticks || !/^\d+$/.test(ticks)) return null;
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!bootId) return null;
    return `linux:${bootId}:${ticks}`;
  } catch {
    return null; // gone, or hidden (hidepid)
  }
}

function readStartTime(pid: number): string | null {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') return linuxStartTime(pid);
  return psStartTime(pid);
}

/**
 * When process `pid` started, as text that is equal for one process and
 * different for a later process given the same pid: ISO8601 UTC to the second
 * on macOS and the BSDs (`ps -o lstart`), `linux:<boot_id>:<ticks>` on Linux
 * (see {@link linuxStartTime}). Null when the OS will not say: no such
 * process, a lookup that failed or ran out, and always on Windows, where no
 * source is read. Null is never evidence: a caller that
 * gets it decides by pid liveness alone.
 *
 * This process's own start time is read until known, then kept. Another pid's answer
 * is reused for {@link START_TIME_CACHE_MS} unless `fresh` is set, which
 * always reads the OS (and refreshes the cache). Synchronous; never throws.
 */
export function processStartTime(pid: number, opts: { fresh?: boolean } = {}): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) {
    // A null first read (a ps that ran out under load) is retried on the next call.
    if (ownStartTime === undefined || ownStartTime === null) ownStartTime = readStartTime(pid);
    return ownStartTime;
  }
  const now = Date.now();
  const hit = startTimeCache.get(pid);
  if (!opts.fresh && hit && now - hit.at >= 0 && now - hit.at < START_TIME_CACHE_MS) return hit.value;
  const value = readStartTime(pid);
  if (startTimeCache.size >= START_TIME_CACHE_MAX) startTimeCache.clear();
  startTimeCache.set(pid, { value, at: now });
  return value;
}
