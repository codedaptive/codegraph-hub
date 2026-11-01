/**
 * Shared pieces of the dead-lock-reclaim tests: the victim that takes locks
 * through the real code, the live unrelated holder that models OS pid reuse,
 * and the rewrite that moves a leftover record onto that holder's pid and
 * changes nothing else.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../../..');

/**
 * Name of the field a lock record carries the holder's OS process start time
 * in: `LockStamp.pidStart` in writer-lock.ts. The tests name it only here.
 */
export const START_FIELD = 'pidStart';

/**
 * Age, in seconds, of a planted `.takeover` guard that must read as stale
 * whatever its pid. The code's threshold is 50 seconds (STALE_GUARD_MS in
 * lock-takeover.ts); 60 s is past it with margin for a slow run, and a guard
 * written just now is well inside it.
 */
export const STALE_GUARD_AGE_S = 60;

/** The TypeScript runner (run-ts.cjs) the running node binary is launched on, as in lock-takeover-race.gate.test.ts. */
const TS_RUNNER = path.join(__dirname, 'run-ts.cjs');
const VICTIM = path.join(__dirname, 'dead-lock-victim.ts');

const started: ChildProcess[] = [];

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Poll `predicate` until truthy. `label` may be a function, so a timeout reports the state at that moment. */
export async function waitFor<T>(
  predicate: () => T | null | undefined | false,
  timeoutMs: number,
  label: string | (() => string),
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > end) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${typeof label === 'string' ? label : label()}`);
    }
    await sleep(25);
  }
}

/** A pid that was alive a moment ago and is now dead: a just-exited child's. */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (typeof r.pid !== 'number' || r.pid <= 0) throw new Error('could not obtain a dead pid');
  return r.pid;
}

/**
 * Start the victim (fixtures/dead-lock-victim.ts) on `root`, taking `locks`
 * through the real code from src, and resolve once it has them all. It holds
 * them until killed. It runs as a separate node process through run-ts.cjs.
 */
export async function startVictim(root: string, locks: string[], timeoutMs = 45_000): Promise<number> {
  const child = spawn(process.execPath, [TS_RUNNER, VICTIM, '--', root, locks.join(',')], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  started.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8'); });
  child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8'); });
  const line = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`victim exited ${child.exitCode}: ${err}`);
    return out.includes('\n') ? out.split('\n')[0] : null;
  }, timeoutMs, 'the victim to take its locks');
  const parsed = JSON.parse(line) as { pid: number; taken: string[] };
  if (parsed.pid !== child.pid) throw new Error(`victim reported pid ${parsed.pid}, spawned ${child.pid}`);
  return parsed.pid;
}

/** SIGKILL `pid` and wait until it is gone (a killed child is reaped by Node). */
export async function killAndWait(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitFor(() => !isAlive(pid), 10_000, `pid ${pid} to exit`);
}

/**
 * Start a live process unrelated to CodeGraph (`sleep 600`) to stand for the
 * process the OS gave a dead lock holder's pid to.
 *
 * It must start in a later wall-clock second than every process whose
 * records it will be named in: an OS start time can have one-second
 * resolution (`ps -o lstart`), and two processes started within one second
 * would look like one. So it waits until at least 1.1 s after `notBefore`
 * (the ms timestamp after which every such process had already started).
 */
export async function startUnrelatedHolder(notBefore: number): Promise<number> {
  const wait = notBefore + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  if (!child.pid) throw new Error('could not start the unrelated holder');
  started.push(child);
  return child.pid;
}

/** Kill every victim and holder this file started. */
export function killStarted(): void {
  for (const c of started.splice(0)) {
    if (c.pid && isAlive(c.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/**
 * Model OS pid reuse on a leftover lock record: replace the pid `from` with
 * `to` and keep every other byte's meaning. JSON records (writer.pid,
 * rebuild.pid, the state dir's server.pid) have their `pid` key replaced; codegraph.lock has
 * its first line (the bare pid) replaced, and its second-line record's `pid`
 * key too if the code records one there. Nothing else changes: the recorded
 * start time stays the dead holder's.
 */
export function reusePid(file: string, from: number, to: number): void {
  const raw = fs.readFileSync(file, 'utf8');
  const swapJson = (text: string): string => {
    const rec = JSON.parse(text) as Record<string, unknown>;
    if (rec.pid === from) rec.pid = to;
    return JSON.stringify(rec);
  };
  let next: string;
  if (path.basename(file) === 'codegraph.lock') {
    const lines = raw.split('\n');
    if (parseInt(lines[0]!, 10) !== from) throw new Error(`${file} names pid ${lines[0]}, not ${from}`);
    lines[0] = String(to);
    if (lines[1] !== undefined && lines[1].trim() !== '') lines[1] = swapJson(lines[1]);
    next = lines.join('\n');
  } else {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    if (rec.pid !== from) throw new Error(`${file} names pid ${String(rec.pid)}, not ${from}`);
    next = swapJson(raw.trim()) + (raw.endsWith('\n') ? '\n' : '');
  }
  fs.writeFileSync(file, next);
}

/** Plant `${lockPath}.takeover` naming `pid`, its mtime `ageS` seconds in the past. */
export function plantGuard(lockPath: string, pid: number, ageS: number): string {
  const guard = `${lockPath}.takeover`;
  fs.writeFileSync(guard, String(pid));
  const t = new Date(Date.now() - ageS * 1000);
  fs.utimesSync(guard, t, t);
  return guard;
}
