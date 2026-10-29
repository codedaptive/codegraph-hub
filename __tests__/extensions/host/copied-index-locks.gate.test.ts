/**
 * A copy of a project taken while the original's daemon runs gets its own
 * daemon, its own writer, and auto-sync.
 *
 * The copy carries the original's daemon.pid, writer.pid and (when the copy
 * landed mid-sync) codegraph.lock, all naming the original's LIVE daemon. Pid
 * liveness alone would make the copy's daemon candidate defer to that live pid
 * and exit, leaving the copy's session serving reads in-process without
 * auto-sync. Each lock record carries the root it was written at and the
 * identity of the physical index it was written for (the inodes of
 * `.codegraph/` and `codegraph.db`). A copy at another path has another root
 * and new inodes, so the copy recognises these as another project's records
 * and treats them as stale. A record at the copy's own root would never be
 * foreign; pid liveness would decide it.
 *
 * Spawns real `node dist/bin/codegraph.js serve --mcp` processes over real
 * sockets, as `__tests__/mcp-daemon.test.ts` does, with copies of its helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { canonicalProjectRoot, getCodeGraphDir, statInode } from '../../../src/directory';
import { recordSpawns, recordedPids, removeSpawnLog, settleLosingCandidates } from '../../daemon-candidates';

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function spawnServer(cwd: string, env: NodeJS.ProcessEnv = {}): SpawnedServer {
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { CODEGRAPH_MCP_LOG_ATTACH: '1', ...process.env, ...recorder.env, ...env },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => { /* ignore */ });
  child.stdin.on('error', () => { /* ignore */ });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      stdout.push(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stderrBuf.indexOf('\n')) !== -1) {
      stderr.push(stderrBuf.slice(0, idx));
      stderrBuf = stderrBuf.slice(idx + 1);
    }
  });
  return { child, stdout, stderr };
}

function sendMessage(child: ChildProcessWithoutNullStreams, msg: unknown): void {
  try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* child may be gone */ }
}

function sendInitialize(child: ChildProcessWithoutNullStreams, rootUri: string, id: number): void {
  sendMessage(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
      rootUri,
    },
  });
}

function findResponse(stdout: string[], id: number): any | null {
  for (const line of stdout) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs: number,
  pollMs = 25,
  label = '',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v: T | undefined | null | false;
      try { v = predicate(); } catch (e) { return reject(e); }
      if (v) return resolve(v as T);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out after ${timeoutMs}ms${label ? ` waiting for: ${label}` : ''}`));
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => !isAlive(pid), timeoutMs).then(() => true).catch(() => false);
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function lockPid(root: string, name: 'daemon.pid' | 'writer.pid'): number | null {
  const rec = readJson(path.join(root, '.codegraph', name));
  return rec && typeof rec.pid === 'number' ? rec.pid : null;
}

function readDaemonLog(root: string): string {
  try { return fs.readFileSync(path.join(root, '.codegraph', 'daemon.log'), 'utf8'); } catch { return ''; }
}

/**
 * Copy a project with its index while its daemon runs. Sockets cannot be
 * copied, and `*.tmp` files are a lock writer's private in-flight records.
 */
function copyProject(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith('.tmp')) return false;
      try { return !fs.lstatSync(src).isSocket(); } catch { return false; }
    },
  });
}

const NEW_SYMBOL = 'copiedIndexFreshlyAddedSymbol';

describe('copied index locks: a copy taken while the original daemon runs syncs on its own', () => {
  let parent: string;
  let srcDir: string;   // S, as spawned (may sit behind the /var symlink on macOS)
  let srcReal: string;  // realpath(S): what the daemon keys on
  let copyDir: string;  // C
  let copyReal: string;
  const servers: SpawnedServer[] = [];
  let srcDaemonPid: number | null = null;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-copied-gate-'));
    srcDir = path.join(parent, 'src-project');
    copyDir = path.join(parent, 'copy-project');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(srcDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    srcReal = fs.realpathSync(srcDir);
    srcDaemonPid = null;
  });

  afterEach(async () => {
    await Promise.all(servers.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    servers.length = 0;
    const fixtures = [srcDir, copyDir];
    // A losing candidate still starting must not outlive the fixture (#1773).
    await settleLosingCandidates(srcDir, () => lockPid(srcReal, 'daemon.pid')).catch(() => { /* reaped below */ });
    if (fs.existsSync(copyDir)) {
      await settleLosingCandidates(copyDir, () => lockPid(fs.realpathSync(copyDir), 'daemon.pid')).catch(() => { /* reaped below */ });
    }
    // Both daemons are detached: reap them by the pids they recorded, plus every
    // candidate either launcher spawned. Never signal the vitest worker itself.
    const pids = new Set<number>();
    if (srcDaemonPid) pids.add(srcDaemonPid);
    for (const root of fixtures) {
      const p = lockPid(root, 'daemon.pid');
      if (p) pids.add(p);
      for (const r of recordedPids(root)) pids.add(r);
    }
    pids.delete(process.pid);
    for (const pid of pids) {
      if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* race */ } }
    }
    for (const pid of pids) await waitProcessExit(pid, 5000);
    for (const root of fixtures) removeSpawnLog(root);
    await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);

  // Exceeds 5 s by design: it starts two real daemons, each with an initial
  // catch-up sync, then waits for a watcher-driven sync of an edit. On a
  // loaded machine each of those steps can take tens of seconds, so every wait
  // carries its own explicit, labelled timeout.
  // POSIX only: on Windows lock records carry no index identity, so a copied record is never foreign and the copy's daemon defers to the original's.
  it.runIf(process.platform !== 'win32')(
    'the copy gets its own daemon and writer, and an edit in the copy is synced and found',
    async () => {
      // 1. S: a running daemon whose writer has finished its catch-up.
      const s = spawnServer(srcDir);
      servers.push(s);
      sendInitialize(s.child, `file://${srcDir}`, 1);
      await waitFor(() => findResponse(s.stdout, 1), 60_000, 50, 'S initialize response');
      srcDaemonPid = await waitFor(() => {
        const pid = lockPid(srcReal, 'daemon.pid');
        return pid && isAlive(pid) ? pid : null;
      }, 60_000, 50, "S's daemon.pid naming a live daemon");
      await waitFor(() => {
        const w = readJson(path.join(srcReal, '.codegraph', 'writer.pid'));
        return w && w.pid === srcDaemonPid && w.ready === true;
      }, 90_000, 50, "S's writer.pid ready:true for its daemon");

      // 2. C: a copy of S taken while S's daemon runs, landed mid-sync.
      copyProject(srcDir, copyDir);
      copyReal = fs.realpathSync(copyDir);
      // The codegraph.lock S's daemon writes while it syncs: its pid, then S's
      // lock stamp, copied over byte for byte.
      const srcDirId = statInode(getCodeGraphDir(srcReal));
      const srcDbId = srcDirId === null ? null : statInode(path.join(getCodeGraphDir(srcReal), 'codegraph.db'));
      const srcStamp = {
        root: canonicalProjectRoot(srcReal),
        ...(srcDirId !== null && srcDbId !== null ? { dirId: srcDirId, dbId: srcDbId } : {}),
      };
      fs.writeFileSync(
        path.join(copyReal, '.codegraph', 'codegraph.lock'),
        `${srcDaemonPid}\n${JSON.stringify(srcStamp)}`,
      );
      // The copied records really do name S's live daemon.
      expect(lockPid(copyReal, 'daemon.pid')).toBe(srcDaemonPid);
      expect(lockPid(copyReal, 'writer.pid')).toBe(srcDaemonPid);

      // 3. serve --mcp in C, with the search tool exposed to find the edit.
      const c = spawnServer(copyDir, { CODEGRAPH_MCP_TOOLS: 'explore,search' });
      servers.push(c);
      sendInitialize(c.child, `file://${copyDir}`, 1);
      await waitFor(() => findResponse(c.stdout, 1), 60_000, 50, 'C initialize response');

      const diagnostics = () =>
        `\n--- C proxy stderr ---\n${c.stderr.join('\n')}\n--- C daemon.log ---\n${readDaemonLog(copyReal)}` +
        `\n--- C daemon.pid ---\n${JSON.stringify(readJson(path.join(copyReal, '.codegraph', 'daemon.pid')))}` +
        `\n--- C writer.pid ---\n${JSON.stringify(readJson(path.join(copyReal, '.codegraph', 'writer.pid')))}`;

      // C's own daemon: a live pid that is not S's, recording C as its root.
      let copyDaemonPid: number;
      try {
        copyDaemonPid = await waitFor(() => {
          const rec = readJson(path.join(copyReal, '.codegraph', 'daemon.pid'));
          const pid = rec && typeof rec.pid === 'number' ? rec.pid : null;
          return pid && pid !== srcDaemonPid && isAlive(pid) && rec!.root === copyReal ? pid : null;
        }, 60_000, 50, "C's daemon.pid naming its own live daemon with root realpath(C)");
      } catch (err) {
        throw new Error(`${(err as Error).message}${diagnostics()}`);
      }

      // C's writer: that daemon, mode 'daemon', and it reaches ready.
      try {
        await waitFor(() => {
          const w = readJson(path.join(copyReal, '.codegraph', 'writer.pid'));
          return w && w.pid === copyDaemonPid && w.mode === 'daemon' && w.ready === true;
        }, 90_000, 50, "C's writer.pid ready:true for C's daemon");
      } catch (err) {
        throw new Error(`${(err as Error).message}${diagnostics()}`);
      }

      // 4. An edit in C is synced and found through C's MCP session.
      fs.writeFileSync(path.join(copyReal, 'added.ts'), `export function ${NEW_SYMBOL}() { return 2; }\n`);
      let nextId = 10;
      let lastText = '';
      try {
        await waitFor(() => {
          const pending = nextId - 1;
          if (pending >= 10) {
            const reply = findResponse(c.stdout, pending);
            if (!reply) return null; // still waiting on the previous call
            lastText = JSON.stringify(reply.result ?? reply.error);
            if (reply.result?.isError !== true && lastText.includes(NEW_SYMBOL) && !lastText.includes('No results found')) {
              return true;
            }
          }
          sendMessage(c.child, {
            jsonrpc: '2.0', id: nextId++, method: 'tools/call',
            params: { name: 'codegraph_search', arguments: { query: NEW_SYMBOL } },
          });
          return null;
        }, 90_000, 500, `C's MCP session finding ${NEW_SYMBOL}`);
      } catch (err) {
        throw new Error(`${(err as Error).message}\nlast reply: ${lastText}${diagnostics()}`);
      }

      // 5. C never fell back to read-only, and S's daemon is untouched.
      expect(c.stderr.some((l) => l.includes('Serving reads in-process without auto-sync'))).toBe(false);
      expect(isAlive(srcDaemonPid!)).toBe(true);
      expect(lockPid(srcReal, 'daemon.pid')).toBe(srcDaemonPid);
    },
    420_000,
  );
});
