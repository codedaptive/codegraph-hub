/**
 * A copy taken while the original's writer is alive reclaims copied project
 * locks and auto-syncs without disturbing the original.
 *
 * writer.pid and a planted mid-sync codegraph.lock name the original's LIVE
 * writer and carry its physical-index stamp. A copy at another root has new
 * directory/database inodes, so these records are foreign there. Project lock
 * stamping is independent of the machine server's state-scoped server.pid.
 *
 * Two isolated state directories give the source and copy genuinely distinct
 * live server processes, each with an index builder of its own (the process
 * that holds the writer locks), exercising the foreign-live-writer case even
 * though all projects sharing one state directory normally use one machine
 * server.
 * Spawns real `node dist/bin/codegraph.js serve --mcp` proxies and servers.
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

function spawnServer(cwd: string, stateDir: string): SpawnedServer {
  const recorder = recordSpawns(cwd);
  const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, ...recorder.args, BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...recorder.env,
      CODEGRAPH_MCP_LOG_ATTACH: '1',
      CODEGRAPH_MCP_TOOLS: 'explore,search',
      CODEGRAPH_STATE_DIR: stateDir,
    },
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

function sendInitialize(child: ChildProcessWithoutNullStreams, id: number): void {
  sendMessage(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
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

/** Projects open lazily on an explicit tool call, not during initialize. */
async function openProject(server: SpawnedServer, projectPath: string): Promise<void> {
  sendMessage(server.child, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'codegraph_search', arguments: { query: 'originalSymbol', projectPath } },
  });
  const reply = await waitFor(() => findResponse(server.stdout, 2), 90_000, 50, `${projectPath} open response`);
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).not.toBe(true);
  expect(JSON.stringify(reply.result)).toContain('originalSymbol');
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

function serverPid(stateDir: string): number | null {
  const rec = readJson(path.join(stateDir, 'server.pid'));
  return rec && typeof rec.pid === 'number' ? rec.pid : null;
}

/** The pid the state dir's index builder recorded: the process that holds every writer lock of its server. */
function builderPid(stateDir: string): number | null {
  const rec = readJson(path.join(stateDir, 'builder.pid'));
  return rec && typeof rec.pid === 'number' ? rec.pid : null;
}

function writerPid(root: string): number | null {
  const rec = readJson(path.join(getCodeGraphDir(root), 'writer.pid'));
  return rec && typeof rec.pid === 'number' ? rec.pid : null;
}

function readServerLog(stateDir: string): string {
  try { return fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8'); } catch { return ''; }
}

/** Copy the live index, excluding sockets and private in-flight lock records. */
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

describe('copied index locks: a copy of a live writer\'s index syncs independently', () => {
  let parent: string;
  let srcDir: string;
  let srcReal: string;
  let copyDir: string;
  let copyReal: string;
  let srcState: string;
  let copyState: string;
  const servers: SpawnedServer[] = [];
  let srcServerPid: number | null = null;

  beforeEach(async () => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-copied-gate-')));
    srcDir = path.join(parent, 'src-project');
    copyDir = path.join(parent, 'copy-project');
    srcState = fs.mkdtempSync(path.join(parent, 'src-state-'));
    copyState = fs.mkdtempSync(path.join(parent, 'copy-state-'));
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export function originalSymbol() { return 1; }\n');
    const cg = await CodeGraph.init(srcDir);
    try { await cg.indexAll(); } finally { cg.close(); }
    srcReal = fs.realpathSync(srcDir);
    srcServerPid = null;
  });

  afterEach(async () => {
    await Promise.all(servers.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    servers.length = 0;
    const fixtures = [{ root: srcDir, state: srcState }, { root: copyDir, state: copyState }];
    // A losing candidate still starting must not outlive the fixture (#1773).
    for (const { root, state } of fixtures) {
      if (fs.existsSync(root)) {
        await settleLosingCandidates(root, () => serverPid(state)).catch(() => { /* reaped below */ });
      }
    }
    // Servers are detached. Reap only these isolated states' recorded holders
    // and their launch candidates, never the vitest worker or a live server.
    const pids = new Set<number>();
    if (srcServerPid) pids.add(srcServerPid);
    for (const { root, state } of fixtures) {
      const pid = serverPid(state);
      if (pid) pids.add(pid);
      const builder = builderPid(state);
      if (builder) pids.add(builder);
      for (const recorded of recordedPids(root)) pids.add(recorded);
    }
    pids.delete(process.pid);
    for (const pid of pids) {
      if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* race */ } }
    }
    for (const pid of pids) await waitProcessExit(pid, 5000);
    for (const { root } of fixtures) removeSpawnLog(root);
    await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);

  // Exceeds 5 s by design: two real state-isolated servers catch up their
  // projects, then a watcher syncs an edit. Loaded-machine startup and sync
  // can each take tens of seconds; every wait has a labelled timeout.
  // POSIX only: Windows project lock stamps carry no physical-index identity,
  // so a copied live writer record cannot be recognised as foreign there.
  it.runIf(process.platform !== 'win32')(
    'a separate-state server reclaims the copy\'s writer locks and finds a synced edit',
    async () => {
      const s = spawnServer(srcDir, srcState);
      servers.push(s);
      sendInitialize(s.child, 1);
      const initialized = await waitFor(() => findResponse(s.stdout, 1), 60_000, 50, 'S initialize response');
      expect(initialized.error).toBeUndefined();
      await openProject(s, srcReal);
      srcServerPid = await waitFor(() => {
        const pid = serverPid(srcState);
        return pid && isAlive(pid) ? pid : null;
      }, 60_000, 50, "S's server.pid naming a live server");
      // The writer is the server's index builder, a process of its own.
      const srcBuilderPid = await waitFor(() => {
        const pid = builderPid(srcState);
        return pid && pid !== srcServerPid && isAlive(pid) ? pid : null;
      }, 60_000, 50, "S's builder.pid naming a live builder");
      await waitFor(() => {
        const writer = readJson(path.join(srcReal, '.codegraph', 'writer.pid'));
        return writer && writer.pid === srcBuilderPid && writer.ready === true;
      }, 90_000, 50, "S's writer.pid ready:true for its builder");

      // Copy the live source and plant the FileLock it would carry mid-sync.
      copyProject(srcDir, copyDir);
      copyReal = fs.realpathSync(copyDir);
      const srcDirId = statInode(getCodeGraphDir(srcReal));
      const srcDbId = srcDirId === null ? null : statInode(path.join(getCodeGraphDir(srcReal), 'codegraph.db'));
      const srcStamp = {
        root: canonicalProjectRoot(srcReal),
        ...(srcDirId !== null && srcDbId !== null ? { dirId: srcDirId, dbId: srcDbId } : {}),
      };
      fs.writeFileSync(
        path.join(copyReal, '.codegraph', 'codegraph.lock'),
        `${srcBuilderPid}\n${JSON.stringify(srcStamp)}`,
      );
      expect(writerPid(copyReal)).toBe(srcBuilderPid);

      const c = spawnServer(copyDir, copyState);
      servers.push(c);
      sendInitialize(c.child, 1);
      const copyInitialized = await waitFor(() => findResponse(c.stdout, 1), 60_000, 50, 'C initialize response');
      expect(copyInitialized.error).toBeUndefined();

      const diagnostics = () =>
        `\n--- C proxy stderr ---\n${c.stderr.join('\n')}\n--- C server.log ---\n${readServerLog(copyState)}` +
        `\n--- C server.pid ---\n${JSON.stringify(readJson(path.join(copyState, 'server.pid')))}` +
        `\n--- C builder.pid ---\n${JSON.stringify(readJson(path.join(copyState, 'builder.pid')))}` +
        `\n--- C writer.pid ---\n${JSON.stringify(readJson(path.join(copyReal, '.codegraph', 'writer.pid')))}`;

      let copyServerPid: number;
      let copyBuilderPid: number;
      try {
        await openProject(c, copyReal);
        copyServerPid = await waitFor(() => {
          const rec = readJson(path.join(copyState, 'server.pid'));
          const pid = rec && typeof rec.pid === 'number' ? rec.pid : null;
          return pid && pid !== srcServerPid && isAlive(pid) && rec!.stateDir === copyState ? pid : null;
        }, 60_000, 50, "C's isolated server.pid naming its own live server");
        copyBuilderPid = await waitFor(() => {
          const pid = builderPid(copyState);
          return pid && pid !== srcBuilderPid && pid !== copyServerPid && isAlive(pid) ? pid : null;
        }, 60_000, 50, "C's isolated builder.pid naming its own live builder");
        await waitFor(() => {
          const writer = readJson(path.join(copyReal, '.codegraph', 'writer.pid'));
          return writer && writer.pid === copyBuilderPid && writer.mode === 'builder' && writer.ready === true;
        }, 90_000, 50, "C's writer.pid ready:true for C's builder");
      } catch (err) {
        throw new Error(`${(err as Error).message}${diagnostics()}`);
      }

      fs.writeFileSync(path.join(copyReal, 'added.ts'), `export function ${NEW_SYMBOL}() { return 2; }\n`);
      let nextId = 10;
      let lastText = '';
      try {
        await waitFor(() => {
          const pending = nextId - 1;
          if (pending >= 10) {
            const reply = findResponse(c.stdout, pending);
            if (!reply) return null;
            lastText = JSON.stringify(reply.result ?? reply.error);
            if (!reply.error && reply.result?.isError !== true && lastText.includes(NEW_SYMBOL) && !lastText.includes('No results found')) {
              return true;
            }
          }
          sendMessage(c.child, {
            jsonrpc: '2.0', id: nextId++, method: 'tools/call',
            params: { name: 'codegraph_search', arguments: { query: NEW_SYMBOL, projectPath: copyReal } },
          });
          return null;
        }, 90_000, 500, `C's MCP session finding ${NEW_SYMBOL}`);
      } catch (err) {
        throw new Error(`${(err as Error).message}\nlast reply: ${lastText}${diagnostics()}`);
      }

      expect(c.stderr.some((line) => line.includes('Serving reads in-process without auto-sync'))).toBe(false);
      expect(writerPid(copyReal)).toBe(copyBuilderPid);
      expect(isAlive(srcServerPid!)).toBe(true);
      expect(isAlive(srcBuilderPid)).toBe(true);
      expect(serverPid(srcState)).toBe(srcServerPid);
      expect(builderPid(srcState)).toBe(srcBuilderPid);
      expect(writerPid(srcReal)).toBe(srcBuilderPid);
    },
    420_000,
  );
});
