/**
 * Query pool idle retirement: the pool shrinks back after a burst.
 *
 * The pool grows toward its size on a burst of concurrent calls. A worker that
 * then sits idle (no call in flight) for `idleTimeoutMs` is retired, oldest
 * idle first, except the worker that served last, which goes only as the sole
 * idle worker, down to one started worker (a worker still starting does not
 * count toward the floor; the worker that stays is trimmed on its own clock,
 * `idleShrinkMs`, covered in query-pool-idle-trim.test.ts). Retiring is
 * a handshake, not a crash: the pool drops the worker from its live set, posts
 * `{ type: 'retire' }`, and waits for the worker's exit (terminating it only
 * after `startSettleMs`). It never respawns, never counts toward the crash
 * budget, and leaves `healthy` and `ready` true. The worker answers `retire`
 * by closing every CodeGraph it opened, posting `{ type: 'retired', closed }`
 * and exiting with code 0.
 *
 * The unit block drives src/mcp/query-pool.ts with injected fake workers. The
 * real-worker block uses the BUILT engine and dist/mcp/query-worker.js against
 * real indexes, as __tests__/query-pool.test.ts does.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Worker } from 'worker_threads';
import { CodeGraph } from '../../../src';
import type { MCPEngine } from '../../../src/mcp/engine';
import { QueryPool, type PoolWorker, type QueryPoolOptions } from '../../../src/mcp/query-pool';
import type { ToolResult } from '../../../src/mcp/tools';
import { ADMIT_ALL } from '../../helpers/admit-all';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

const makePool = (opts: QueryPoolOptions): QueryPool => new QueryPool(opts);

interface CallMsg { type: 'call'; id: number; toolName: string; args: Record<string, unknown> }

/** A promise a test opens by hand, to hold a call in flight. */
class Gate {
  readonly promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((r) => { this.open = r; }); }
}

/**
 * Fake worker speaking the pool's protocol. It records every message the pool
 * posts. A call is answered by `onCall` (which may wait on a Gate to stay in
 * flight). `{ type: 'retire' }` is answered as the real worker answers it:
 * `{ type: 'retired' }` then exit code 0, on a macrotask; with
 * `exitOnRetire: false` the fake never exits, to model a wedged retirement.
 * terminate() only records the call and emits nothing. It resolves at once,
 * except on a fake already told to retire when `retiredTerminate` is given:
 * then it returns that promise, so a test holds the retired worker's
 * termination pending. `emitEvent` fires an 'error' or 'exit' at the pool by
 * hand, as a worker dying on its own would.
 */
class IdleFake implements PoolWorker {
  readonly posted: unknown[] = [];
  terminateCalled = false;
  exited = false;
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  private errorCb?: (err: unknown) => void;
  constructor(
    private readonly onCall: (w: IdleFake, m: CallMsg) => Promise<ToolResult> | ToolResult,
    private readonly exitOnRetire = true,
    private readonly retiredTerminate?: Promise<number>,
  ) {
    setTimeout(() => this.msgCb?.({ type: 'ready', ok: true }), 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
    else if (event === 'error') this.errorCb = cb;
  }
  emitEvent(event: 'error' | 'exit', code = 1): void {
    if (event === 'error') {
      this.errorCb?.(new Error('fake worker error'));
      return;
    }
    this.exited = true;
    this.exitCb?.(code);
  }
  get retired(): boolean {
    return this.posted.some((m) => (m as { type?: string })?.type === 'retire');
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
    const m = msg as { type?: string };
    if (m?.type === 'retire') {
      if (!this.exitOnRetire) return;
      setTimeout(() => {
        this.msgCb?.({ type: 'retired', closed: 1 });
        this.exited = true;
        this.exitCb?.(0);
      }, 0);
      return;
    }
    if (m?.type !== 'call') return;
    const call = msg as CallMsg;
    void Promise.resolve(this.onCall(this, call)).then((result) => {
      setTimeout(() => { if (!this.exited) this.msgCb?.({ type: 'result', id: call.id, result }); }, 0);
    });
  }
  terminate(): Promise<number> {
    this.terminateCalled = true;
    if (this.retired && this.retiredTerminate) return this.retiredTerminate;
    return Promise.resolve(1);
  }
}

describe('QueryPool idle retirement (fake workers)', () => {
  let pool: QueryPool | null = null;

  afterEach(async () => {
    await pool?.destroy();
    pool = null;
  });

  /**
   * Run `n` calls that stay in flight until their gate opens; wait until all
   * are on workers. The calls come back wrapped: an async function returning
   * the bare promise would adopt it and wait for the gate itself.
   */
  async function burst(p: QueryPool, n: number, active: { count: number }): Promise<{ calls: Promise<ToolResult[]> }> {
    const calls = Promise.all(Array.from({ length: n }, (_, i) => p.run('codegraph_explore', { i })));
    await vi.waitFor(() => {
      expect(active.count).toBe(n);
      expect(p.liveWorkers).toBe(n);
    });
    return { calls };
  }

  it('retires idle workers after a burst down to one started worker (gate)', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    const gate = new Gate();
    pool = makePool({
      size: 4, idleTimeoutMs: 50,
      createWorker: () => {
        const f = new IdleFake(async (_w, m) => {
          active.count++;
          if ((m.args as { i?: number }).i !== undefined) await gate.promise;
          active.count--;
          return ok(`r${m.id}`);
        });
        fakes.push(f);
        return f;
      },
    });
    const { calls } = await burst(pool, 4, active);
    gate.open();
    expect((await calls).every((r) => /^r\d+$/.test(r.content[0].text))).toBe(true);

    await vi.waitFor(() => expect(pool!.liveWorkers).toBe(1), { timeout: 2000 });
    expect(fakes).toHaveLength(4);
    expect(fakes.filter((f) => f.retired)).toHaveLength(3);
    expect(fakes.filter((f) => !f.retired)).toHaveLength(1);
    expect(pool.healthy).toBe(true);
    expect(pool.ready).toBe(true);

    const after = await pool.run('codegraph_search', { query: 'q' });
    expect(after.isError).toBeFalsy();
    expect(after.content[0].text).toMatch(/^r\d+$/);
    // No respawn: the survivor served the call.
    expect(fakes).toHaveLength(4);
  });

  it('never retires a worker with a call in flight', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    const gates = [new Gate(), new Gate()];
    const servedBy = new Map<number, IdleFake>(); // call arg i -> fake
    pool = makePool({
      size: 2, idleTimeoutMs: 50,
      createWorker: () => {
        const f = new IdleFake(async (w, m) => {
          const i = (m.args as { i: number }).i;
          servedBy.set(i, w);
          active.count++;
          await gates[i].promise;
          active.count--;
          return ok(`r${i}`);
        });
        fakes.push(f);
        return f;
      },
    });
    const calls = Array.from({ length: 2 }, (_, i) => pool!.run('codegraph_explore', { i }));
    await vi.waitFor(() => {
      expect(active.count).toBe(2);
      expect(pool!.liveWorkers).toBe(2);
    });
    const idleOne = servedBy.get(0)!;
    const busyOne = servedBy.get(1)!;
    expect(idleOne).not.toBe(busyOne);

    gates[0].open();
    expect((await calls[0]).content[0].text).toBe('r0');
    // The idle worker is retired; the busy one is not, however long it is held.
    await vi.waitFor(() => expect(pool!.liveWorkers).toBe(1), { timeout: 2000 });
    expect(idleOne.retired).toBe(true);
    expect(busyOne.retired).toBe(false);
    await sleep(200); // four idle timeouts with the call still held
    expect(busyOne.retired).toBe(false);
    expect(pool.liveWorkers).toBe(1);

    gates[1].open();
    expect((await calls[1]).content[0].text).toBe('r1');
    expect(pool.healthy).toBe(true);
  });

  it('never retires when idleTimeoutMs is 0', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    const gate = new Gate();
    pool = makePool({
      size: 3, idleTimeoutMs: 0,
      createWorker: () => {
        const f = new IdleFake(async (_w, m) => {
          active.count++;
          await gate.promise;
          active.count--;
          return ok(`r${m.id}`);
        });
        fakes.push(f);
        return f;
      },
    });
    const { calls } = await burst(pool, 3, active);
    gate.open();
    await calls;
    await sleep(300); // six times the 50 ms timeout the other tests use
    expect(pool.liveWorkers).toBe(3);
    expect(fakes.some((f) => f.retired)).toBe(false);
  });

  it('does not count retirements toward the crash budget', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    let gate = new Gate();
    pool = makePool({
      size: 2, idleTimeoutMs: 20,
      createWorker: () => {
        const f = new IdleFake(async (_w, m) => {
          active.count++;
          await gate.promise;
          active.count--;
          return ok(`r${m.id}`);
        });
        fakes.push(f);
        return f;
      },
    });
    // 13 cycles: one more retirement than CRASH_BUDGET (12) in query-pool.ts.
    for (let cycle = 0; cycle < 13; cycle++) {
      gate = new Gate();
      const { calls } = await burst(pool, 2, active);
      gate.open();
      for (const r of await calls) expect(r.content[0].text).toMatch(/^r\d+$/);
      await vi.waitFor(() => expect(pool!.liveWorkers).toBe(1), { timeout: 2000 });
      expect(pool.healthy).toBe(true);
      expect(pool.ready).toBe(true);
    }
    expect(fakes.filter((f) => f.retired).length).toBeGreaterThanOrEqual(13);
    gate = new Gate();
    gate.open();
    const last = await pool.run('codegraph_search', { query: 'q' });
    expect(last.isError).toBeFalsy();
  });

  it('destroy() ends a worker whose retirement never exits', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    const gate = new Gate();
    pool = makePool({
      size: 2, idleTimeoutMs: 50, startSettleMs: 50,
      createWorker: () => {
        const f = new IdleFake(async (_w, m) => {
          active.count++;
          await gate.promise;
          active.count--;
          return ok(`r${m.id}`);
        }, false);
        fakes.push(f);
        return f;
      },
    });
    const { calls } = await burst(pool, 2, active);
    gate.open();
    await calls;
    await vi.waitFor(() => expect(fakes.some((f) => f.retired)).toBe(true), { timeout: 2000 });
    const wedged = fakes.find((f) => f.retired)!;
    const p = pool;
    pool = null;
    await p.destroy();
    expect(wedged.terminateCalled).toBe(true);
  });

  it('destroy() waits for a retired worker whose terminate() is still pending (gate)', async () => {
    const fakes: IdleFake[] = [];
    const active = { count: 0 };
    const gate = new Gate();
    let endTerminate!: (code: number) => void;
    const retiredTerminate = new Promise<number>((r) => { endTerminate = r; });
    pool = makePool({
      size: 2, idleTimeoutMs: 50, startSettleMs: 50,
      createWorker: () => {
        const f = new IdleFake(async (_w, m) => {
          active.count++;
          await gate.promise;
          active.count--;
          return ok(`r${m.id}`);
        }, false, retiredTerminate);
        fakes.push(f);
        return f;
      },
    });
    const { calls } = await burst(pool, 2, active);
    gate.open();
    await calls;
    // The retired fake never exits, so its startSettleMs cap fires and calls
    // terminate(), which stays pending until endTerminate.
    await vi.waitFor(() => expect(fakes.some((f) => f.retired && f.terminateCalled)).toBe(true), { timeout: 2000 });
    const p = pool;
    pool = null;
    let destroyed = false;
    const d = p.destroy().then(() => { destroyed = true; });
    try {
      await sleep(100);
      expect(destroyed).toBe(false);
    } finally {
      endTerminate(1);
    }
    await d;
    expect(destroyed).toBe(true);
  });

  it.each(['error', 'exit'] as const)(
    'an %s event while a retired worker\'s terminate() is pending neither releases destroy() nor counts as a crash (gate)',
    async (event) => {
      const fakes: IdleFake[] = [];
      const active = { count: 0 };
      const gate = new Gate();
      let endTerminate!: (code: number) => void;
      const retiredTerminate = new Promise<number>((r) => { endTerminate = r; });
      pool = makePool({
        size: 2, idleTimeoutMs: 50, startSettleMs: 50,
        createWorker: () => {
          const f = new IdleFake(async (_w, m) => {
            active.count++;
            await gate.promise;
            active.count--;
            return ok(`r${m.id}`);
          }, false, retiredTerminate);
          fakes.push(f);
          return f;
        },
      });
      const { calls } = await burst(pool, 2, active);
      gate.open();
      await calls;
      // The retired fake never exits, so its startSettleMs cap calls
      // terminate(), which stays pending until endTerminate.
      await vi.waitFor(() => expect(fakes.some((f) => f.retired && f.terminateCalled)).toBe(true), { timeout: 2000 });
      const doomed = fakes.find((f) => f.retired)!;
      try {
        // An error, or an exit with a non-zero code, in that window.
        doomed.emitEvent(event, 1);
        // Not a crash: the pool stays healthy and spawns no replacement.
        expect(pool.healthy).toBe(true);
        expect(pool.liveWorkers).toBe(1);
        expect(fakes).toHaveLength(2);
        const p = pool;
        pool = null;
        let destroyed = false;
        const d = p.destroy().then(() => { destroyed = true; });
        await sleep(100);
        // Still waiting on the retired worker's terminate().
        expect(destroyed).toBe(false);
        expect(fakes).toHaveLength(2);
        endTerminate(1);
        await d;
        expect(destroyed).toBe(true);
      } finally {
        endTerminate(1);
      }
    },
  );
});

// Use the built engine so its pool loads the real compiled worker sibling.
const BuiltEngine: typeof MCPEngine = require('../../../dist/mcp/engine').MCPEngine;
const WORKER_FILE = path.resolve(__dirname, '../../../dist/mcp/query-worker.js');
const HAS_LSOF = process.platform !== 'win32' && spawnSync('lsof', ['-v']).error === undefined;

/** This process's open fds on exactly these files, per `lsof -p <pid> -Fn`. */
function openFdCount(files: string[]): number {
  const out = spawnSync('lsof', ['-p', String(process.pid), '-Fn'], { encoding: 'utf8' }).stdout ?? '';
  const wanted = new Set(files);
  return out.split('\n').filter((l) => l.startsWith('n') && wanted.has(l.slice(1))).length;
}

describe('query pool idle retirement (real workers)', () => {
  let tempDir: string;
  let engine: MCPEngine | undefined;
  let pool: QueryPool | null;
  let worker: Worker | null;
  let workerReady: boolean;
  let workerExited: boolean;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pool-idle-')));
    pool = null;
    worker = null;
    workerReady = false;
    workerExited = false;
    vi.stubEnv('CODEGRAPH_QUERY_POOL_SIZE', '2');
    vi.stubEnv('CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS', '500');
    // Keep the handler's own per-project idle release out of the fd counts:
    // only a worker's retirement may close its connections here. A trim also
    // closes projects; the default idleShrinkMs (5 min) keeps it out of this
    // test's window.
    vi.stubEnv('CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', '0');
  });

  afterEach(async () => {
    // A worker still starting must not be terminated (src/worker-teardown.ts).
    if (worker && workerReady && !workerExited) await worker.terminate();
    worker = null;
    await pool?.destroy();
    await engine?.stop();
    engine = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function indexProject(name: string, symbol: string): Promise<string> {
    const root = path.join(tempDir, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'app.ts'), `export function ${symbol}() { return 42; }\n`);
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
    return root;
  }

  // Can run past 5 s under load: it indexes two projects, starts two real
  // worker threads (each loads the compiled engine and opens SQLite), and then
  // waits out the 500 ms idle timeout and the retirement handshake.
  it('shrinks to one worker after a burst and closes the retired worker\'s connections (gate)', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const beta = await indexProject('beta', 'betaSymbol');
    engine = new BuiltEngine({ watch: false, queryPool: true });
    pool = (engine as unknown as { queryPool: QueryPool | null }).queryPool;
    expect(pool).not.toBeNull();
    await vi.waitFor(() => expect(pool!.ready).toBe(true), { timeout: 15000 });
    const handler = engine.getToolHandler();
    await handler.execute('codegraph_status', { projectPath: alpha }, undefined, ADMIT_ALL);

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => handler.execute(
      'codegraph_explore',
      { projectPath: i % 2 ? beta : alpha, query: i % 2 ? 'betaSymbol' : 'alphaSymbol' }, undefined, ADMIT_ALL,
    )));
    for (const r of results) expect(r.isError).toBeFalsy();
    expect(pool!.liveWorkers).toBe(2);

    // No worker has a default project: a worker holds a project only once a
    // call that names it landed on that worker, so which projects the retired
    // worker held (none, alpha, beta or both) depends on how the burst was
    // spread. The total over both can therefore only be asserted not to grow.
    // Count the `-wal` handle, not `codegraph.db`: each connection holds its
    // own `-wal` fd and closing the connection closes it, but SQLite keeps a
    // closed connection's main `.db` fd open while another connection in the
    // same process still has that WAL database open (the engine's main thread
    // holds both projects), so the `.db` count does not drop on retirement.
    const [alphaWal, betaWal] = [alpha, beta].map((r) => path.join(fs.realpathSync(path.join(r, '.codegraph')), 'codegraph.db-wal'));
    const totalAfterBurst = HAS_LSOF ? openFdCount([alphaWal, betaWal]) : 0;

    await vi.waitFor(() => expect(pool!.liveWorkers).toBe(1), { timeout: 15000 });
    expect(pool!.healthy).toBe(true);
    expect(pool!.ready).toBe(true);

    if (HAS_LSOF) {
      // The main thread and the surviving worker(s) still hold their handles;
      // the retired worker's, if it held any, are closed.
      expect(totalAfterBurst).toBeGreaterThan(0);
      expect(openFdCount([alphaWal, betaWal])).toBeLessThanOrEqual(totalAfterBurst);
    }

    const after = await handler.execute('codegraph_explore', { projectPath: beta, query: 'betaSymbol' }, undefined, ADMIT_ALL);
    expect(after.isError).toBeFalsy();
    expect(after.content[0].text).toContain('betaSymbol');
  }, 45000);

  // Can run past 5 s under load: it indexes two projects and starts a real
  // worker thread, which loads the compiled engine and opens SQLite.
  it('a worker told to retire closes its default and opened projects and exits 0', async () => {
    const alpha = await indexProject('alpha', 'alphaSymbol');
    const beta = await indexProject('beta', 'betaSymbol');
    const messages: Array<{ type?: string; id?: number; closed?: number; result?: ToolResult }> = [];
    const w = new Worker(WORKER_FILE, { workerData: { root: alpha } });
    worker = w;
    const exit = new Promise<number>((resolve) => w.once('exit', (code) => { workerExited = true; resolve(code); }));
    w.on('message', (m) => {
      messages.push(m);
      if (m?.type === 'ready') workerReady = true;
    });

    await vi.waitFor(() => expect(workerReady).toBe(true), { timeout: 15000 });
    expect(messages.find((m) => m.type === 'ready')).toMatchObject({ ok: true });

    w.postMessage({ type: 'call', id: 1, toolName: 'codegraph_explore', args: { projectPath: beta, query: 'betaSymbol' } });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'result' && m.id === 1)).toBe(true), { timeout: 15000 });
    const result = messages.find((m) => m.type === 'result' && m.id === 1)!.result!;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('betaSymbol');

    w.postMessage({ type: 'retire' });
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'retired')).toBe(true), { timeout: 5000 });
    expect(messages.find((m) => m.type === 'retired')).toEqual({ type: 'retired', closed: 2 });
    expect(await exit).toBe(0);
  }, 30000);
});
