/**
 * Query worker thread — issue: concurrent MCP tool calls starve the daemon.
 *
 * The shared daemon serves every session on ONE event loop with synchronous
 * `node:sqlite`. `codegraph_explore` is CPU-heavy (FTS + RWR/personalized-
 * PageRank + impact + output building) stitched together by microtask `await`s,
 * so N concurrent explores keep the microtask queue continuously full and
 * starve the macrotask phases — timers AND socket I/O. The transport freezes:
 * no response flushes, no request is read, until the whole batch drains. With
 * ~10 subagents that routinely exceeds the MCP client's request timeout.
 *
 * This worker moves the heavy read-tool dispatch OFF the daemon's main loop.
 * Each worker owns its OWN read connection (node:sqlite WAL allows N concurrent
 * readers across connections — verified: a worker reader sees the index
 * builder's committed catch-up/watcher writes), so {@link QueryPool} runs N tool calls in
 * true parallel up to core count while the main loop stays free for the MCP
 * transport. The worker runs {@link ToolHandler.executeReadTool} — validation +
 * dispatch + error classification — and returns the raw {@link ToolResult}; the
 * MAIN thread keeps the catch-up gate, the watcher-state notices (staleness /
 * worktree), `codegraph_status`, and telemetry, none of which a watcher-less
 * read connection can answer.
 *
 * When the pool shrinks after a burst it sends `retire` to an idle worker: the
 * worker closes every CodeGraph it opened, collects garbage (see
 * src/worker-teardown.ts), answers `retired` and exits 0. The one worker the
 * retirement leaves is sent `trim` once it has been idle for the pool's
 * `idleShrinkMs` (5 min by default) and has served since its last trim: it
 * shrinks in place (ToolHandler.releaseIdleMemory) and answers `trimmed` with the bytes it
 * still holds, so the next call finds it warm.
 *
 * When a project goes away (the housekeeping sweep tears down a removed
 * worktree, or a pass finds a held root's directory or database gone; see
 * src/extensions/host/worktree-lifecycle/teardown.ts and housekeeping.ts) the
 * pool sends `release` with its root: the worker closes its own connection to
 * it and answers `released`, so the database's blocks are freed once deleted.
 */

import { parentPort, workerData } from 'worker_threads';
import type { ToolResult } from './tools';
import { collectBeforeExit } from '../worker-teardown';

interface WorkerInit {
  root: string | null;
}

/**
 * Messages from the pool. `call` runs one read tool and is answered with
 * `{ type: 'result', id, result }`. `retire` is sent only while no call is in
 * flight; it is answered with `{ type: 'retired', closed }` and then exit code
 * 0. `closed` is the handler's cached projects when closeAll() resolves (none
 * of them if it rejects, even any it closed before rejecting), plus the
 * default project if the worker has one and its close succeeds. `release` closes one project in the
 * handler's cache (ToolHandler.releaseProjectRoot: it waits for the
 * worker's in-flight calls to finish; a later call opens it again) and is
 * answered with `{ type: 'released', id, ok, error? }`; it is answered `ok` with nothing to
 * do when the worker never opened the project, is retiring, or failed to
 * start. A worker's default project, if it has one, is never released this way.
 * `trim` is sent only while no call is in flight; it is answered with
 * `{ type: 'trimmed', heldBytes }` and the worker goes on serving.
 */
interface CallMessage {
  type: 'call';
  id: number;
  toolName: string;
  args: Record<string, unknown>;
}

interface RetireMessage {
  type: 'retire';
}

interface ReleaseMessage {
  type: 'release';
  id: number;
  root: string;
}

/** The pool keeping this idle worker: give back what it can, and say what is left. */
interface TrimMessage {
  type: 'trim';
}

type PoolMessage = CallMessage | RetireMessage | ReleaseMessage | TrimMessage;

// Mirror the engine's lazy-require of the heavy CodeGraph + tools chain. This
// module is only ever loaded as a Worker, so the require runs once on spawn.
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
const loadToolHandler = (): typeof import('./tools').ToolHandler =>
  (require('./tools') as typeof import('./tools')).ToolHandler;

if (parentPort) {
  const port = parentPort;
  const { root } = workerData as WorkerInit;

  // The pool spawns workers with `root: null`: no project is open at spawn,
  // because the server has no default project and every call names its own.
  // Each project is opened lazily on its first call by the ToolHandler's own
  // per-handler cache, and all of them are closed on retire. A worker started
  // with a root (a test that drives a worker directly) opens that one READ
  // connection up front as its default. Workers are pure readers: that default
  // opens read-only, the handler is marked read-only so every project it opens
  // is too (no migration, no index repair, no WAL maintenance), and nothing
  // starts a watcher. Every index write is the index builder's, in its own
  // process.
  let cg: ReturnType<typeof import('../index').default.openSync> | null = null;
  let handler: InstanceType<typeof import('./tools').ToolHandler> | null = null;
  let initError: string | null = null;
  try {
    cg = root ? loadCodeGraph().openSync(root, { readOnly: true }) : null;
    handler = new (loadToolHandler())(cg);
    handler.setReadOnly(true);
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }

  // Tell the pool we're up. `ok:false` lets the pool count a hard open failure
  // against its crash budget (→ fall back to in-process) without hanging.
  port.postMessage({ type: 'ready', ok: initError === null, error: initError });

  let retiring = false;
  port.on('message', (msg: PoolMessage) => {
    if (!msg) return;
    if (msg.type === 'retire') {
      if (retiring) return; // a second retire changes nothing
      retiring = true;
      void retire();
      return;
    }
    if (msg.type === 'release') {
      void release(msg);
      return;
    }
    if (msg.type === 'trim') {
      if (!retiring) trim();
      return;
    }
    if (msg.type !== 'call' || retiring) return;
    void serve(msg);
  });

  // Close every CodeGraph this worker opened, then exit 0. closeAll() closes
  // the handler's per-project cache (which also holds what extension tools
  // opened through it) and resolves at once here: a worker's handler has no
  // project lifecycle, and the pool never retires a worker with a call in
  // flight. It never closes the default project (pool workers have none; only a
  // worker started with a root does), so that is closed here.
  // `closed` is the cached projects, counted before closeAll() empties the
  // cache and added only if it resolves: if it rejects none of them counts,
  // even any it closed first (ToolHandler reports no per-project result).
  // A default project, if the worker has one, adds one if its close succeeds.
  const retire = async (): Promise<void> => {
    let closed = 0;
    if (handler) {
      const cached = cachedProjectCount(handler);
      try {
        await handler.closeAll();
        closed += cached;
      } catch { /* exiting anyway; none of them counts as closed */ }
    }
    if (cg) {
      try { cg.close(); closed++; } catch { /* exiting anyway */ }
    }
    collectBeforeExit();
    port.postMessage({ type: 'retired', closed });
    process.exit(0);
  };

  // Give back what an idle worker can without going cold, and say what it
  // still holds: the handler closes every project but the last one used and
  // its connections let go of their page cache and file mapping; compiled
  // code, the connections' memos and the heap stay (V8 shrinks an idle
  // thread's heap by itself). The pool replaces a worker still holding a lot.
  const trim = (): void => {
    try {
      handler?.releaseIdleMemory();
    } catch { /* a worker that can't let go still serves */ }
    // This thread's own heap and buffers: `rss` is the whole process's.
    const { heapUsed, external } = process.memoryUsage();
    port.postMessage({ type: 'trimmed', heldBytes: heapUsed + external });
  };

  // Close one project this worker's handler holds, then ack. A retiring worker
  // closes everything anyway, and one that failed to start holds nothing.
  const release = async (msg: ReleaseMessage): Promise<void> => {
    if (retiring || !handler) {
      port.postMessage({ type: 'released', id: msg.id, ok: true });
      return;
    }
    try {
      await handler.releaseProjectRoot(msg.root);
      port.postMessage({ type: 'released', id: msg.id, ok: true });
    } catch (err) {
      port.postMessage({ type: 'released', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const serve = async (msg: CallMessage): Promise<void> => {
    // Test-only crash hook so the pool's worker-recovery path is exercisable
    // deterministically. Gated behind an env flag only the suite sets — inert in
    // normal operation (and `__test_crash__` isn't a real tool name anyway).
    if (msg.toolName === '__test_crash__' && process.env.CODEGRAPH_QUERY_WORKER_ALLOW_TEST_CRASH === '1') {
      process.exit(13);
    }
    if (!handler) {
      port.postMessage({
        type: 'result',
        id: msg.id,
        result: errorResult(`codegraph worker could not open the project: ${initError}`),
      });
      return;
    }
    try {
      // executeReadTool already classifies NotIndexed/PathRefusal/internal errors
      // into a ToolResult and never throws — the catch is belt-and-suspenders.
      const result: ToolResult = await handler.executeReadTool(msg.toolName, msg.args);
      port.postMessage({ type: 'result', id: msg.id, result });
    } catch (err) {
      port.postMessage({
        type: 'result',
        id: msg.id,
        result: errorResult(err instanceof Error ? err.message : String(err)),
      });
    }
  };
}

/**
 * How many projects the handler holds open besides the default (none for a
 * pool worker): the ones closeAll() closes. ToolHandler keeps them in a private cache and exposes no
 * count, so this reads the cache's size structurally (0 if it is not there).
 */
function cachedProjectCount(handler: object): number {
  const cache = (handler as { projectCache?: unknown }).projectCache;
  return cache instanceof Map ? cache.size : 0;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
