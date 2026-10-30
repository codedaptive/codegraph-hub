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
 * readers across connections — verified: a worker reader sees the main writer's
 * committed catch-up/watcher writes), so {@link QueryPool} runs N tool calls in
 * true parallel up to core count while the main loop stays free for the MCP
 * transport. The worker runs {@link ToolHandler.executeReadTool} — validation +
 * dispatch + error classification — and returns the raw {@link ToolResult}; the
 * MAIN thread keeps the catch-up gate, the watcher-state notices (staleness /
 * worktree), `codegraph_status`, and telemetry, none of which a watcher-less
 * read connection can answer.
 *
 * When the pool shrinks after a burst it sends `retire` to an idle worker: the
 * worker closes every CodeGraph it opened, collects garbage (see
 * src/worker-teardown.ts), answers `retired` and exits 0.
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
 * default project if its close succeeds. `release` closes one project in the
 * handler's cache (ToolHandler.releaseProjectRoot: it waits for the
 * worker's in-flight calls to finish; a later call opens it again) and is
 * answered with `{ type: 'released', id, ok, error? }`; it is answered `ok` with nothing to
 * do when the worker never opened the project, is retiring, or failed to
 * start. The worker's default project is never released this way.
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

type PoolMessage = CallMessage | RetireMessage | ReleaseMessage;

// Mirror the engine's lazy-require of the heavy CodeGraph + tools chain. This
// module is only ever loaded as a Worker, so the require runs once on spawn.
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
const loadToolHandler = (): typeof import('./tools').ToolHandler =>
  (require('./tools') as typeof import('./tools')).ToolHandler;

if (parentPort) {
  const port = parentPort;
  const { root } = workerData as WorkerInit;

  // Open the default project's READ connection once, if present. Other repos are
  // opened lazily on first cross-project (projectPath) call by the ToolHandler's
  // own per-handler cache. All of them are closed on retire. openSync does not
  // start a watcher — workers are pure readers; the single watcher/writer stays
  // on the daemon's main thread.
  let cg: ReturnType<typeof import('../index').default.openSync> | null = null;
  let handler: InstanceType<typeof import('./tools').ToolHandler> | null = null;
  let initError: string | null = null;
  try {
    cg = root ? loadCodeGraph().openSync(root) : null;
    handler = new (loadToolHandler())(cg);
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
    if (msg.type !== 'call' || retiring) return;
    void serve(msg);
  });

  // Close every CodeGraph this worker opened, then exit 0. closeAll() closes
  // the handler's per-project cache (which also holds what extension tools
  // opened through it) and resolves at once here: a worker's handler has no
  // project lifecycle, and the pool never retires a worker with a call in
  // flight. It never closes the default project, so that is closed here.
  // `closed` is the cached projects, counted before closeAll() empties the
  // cache and added only if it resolves: if it rejects none of them counts,
  // even any it closed first (ToolHandler reports no per-project result).
  // The default project adds one if its close succeeds.
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
 * How many projects the handler holds open besides the default: the ones
 * closeAll() closes. ToolHandler keeps them in a private cache and exposes no
 * count, so this reads the cache's size structurally (0 if it is not there).
 */
function cachedProjectCount(handler: object): number {
  const cache = (handler as { projectCache?: unknown }).projectCache;
  return cache instanceof Map ? cache.size : 0;
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
