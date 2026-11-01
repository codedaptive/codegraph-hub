/**
 * Query pool trim delay: how long the last started worker stays idle before it
 * is trimmed in place. This file pins that the trim has a delay of its own,
 * `idleShrinkMs` (default 300 000 ms), separate from the delay that retires
 * spare workers, `idleTimeoutMs`.
 *
 *   - `idleTimeoutMs` retires spare workers, oldest idle first, except the
 *     worker that served last, which goes only as the sole idle worker, down to
 *     one started worker. `0` never retires; a pool that has grown then never
 *     gets down to the one worker that is trimmed.
 *   - `idleShrinkMs` is how long the one worker left stays idle before it is
 *     trimmed in place: it closes every project but the last one it used and
 *     stays up. `0`, a negative or a non-finite value never trims.
 *   - The trim also needs the pool down to that one worker, nothing queued,
 *     running or starting, and the worker to have served a call since its last
 *     trim. `idleTimeoutMs: 0` does not stop the trim of a pool that never grew;
 *     a pool that grew is never trimmed.
 *
 * The workers are fakes speaking the pool's protocol (ready, result, trim,
 * trimmed, retire, retired). Each one counts the trim messages the pool posts
 * to it. Nothing here spawns a thread or needs a built dist/.
 *
 * Timing: every positive wait is vi.waitFor with a timeout far above the delay
 * it waits for, because a loaded machine can delay any timer. Each negative wait is a
 * short sleep about twelve times the short delay it guards.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { QueryPool, type PoolWorker, type QueryPoolOptions } from '../../../src/mcp/query-pool';
import type { ToolResult } from '../../../src/mcp/tools';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

/** Positive waits: far above the delay under test. */
const WAIT_MS = 3000;
/** Negative waits: about twelve times the 5 ms delay (`idleTimeoutMs` or `idleShrinkMs`) they guard. */
const QUIET_MS = 60;

interface CallMsg { type: 'call'; id: number; toolName: string; args: Record<string, unknown> }

/** A promise a test opens by hand, to hold calls in flight. */
class Gate {
  readonly promise: Promise<void>;
  open!: () => void;
  constructor() { this.promise = new Promise<void>((resolve) => { this.open = resolve; }); }
}

/**
 * Fake worker speaking the pool's protocol. It reports ready on a macrotask and
 * answers each call with whatever `answer` resolves to. It answers 'retire' as
 * the real worker does: 'retired', then exit code 0, on a macrotask. Each 'trim'
 * is counted and answered with 'trimmed' holding nothing, so the pool keeps the
 * worker in place rather than replacing it.
 */
class FakeWorker implements PoolWorker {
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;
  private alive = true;
  /** Trim messages the pool has posted to this worker. */
  trims = 0;
  /** Set once the pool has posted 'retire' to this worker. */
  retireReceived = false;

  constructor(private readonly answer: (call: CallMsg) => Promise<ToolResult>) {
    setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'ready', ok: true }); }, 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
  }
  postMessage(msg: unknown): void {
    const m = msg as { type?: string };
    if (m?.type === 'trim') {
      this.trims++;
      if (this.alive) this.msgCb?.({ type: 'trimmed', heldBytes: 0 });
      return;
    }
    if (m?.type === 'retire') {
      this.retireReceived = true;
      this.alive = false;
      setTimeout(() => { this.msgCb?.({ type: 'retired', closed: 0 }); this.exitCb?.(0); }, 0);
      return;
    }
    if (m?.type !== 'call') return;
    const call = msg as CallMsg;
    void this.answer(call).then((result) => {
      setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'result', id: call.id, result }); }, 0);
    });
  }
  terminate(): Promise<number> { this.alive = false; return Promise.resolve(0); }
}

const pools: QueryPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.destroy();
});

/**
 * A pool of fake workers, kept in creation order. `answer` gives each call's
 * result, and so decides how long the call stays in flight.
 */
function makePool(
  opts: QueryPoolOptions,
  answer: (call: CallMsg) => Promise<ToolResult> = async (call) => ok(`answer ${call.id}`),
): { pool: QueryPool; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const pool = new QueryPool({
    ...opts,
    createWorker: () => {
      const worker = new FakeWorker(answer);
      workers.push(worker);
      return worker;
    },
  });
  pools.push(pool);
  return { pool, workers };
}

/**
 * Two calls held in flight until `gate` opens. The pool grows to two started
 * workers and both are busy; then both calls finish.
 */
async function burstOfTwo(pool: QueryPool, gate: Gate, active: { count: number }): Promise<void> {
  const calls = [0, 1].map((i) => pool.run('codegraph_explore', { i }));
  await vi.waitFor(() => expect(active.count).toBe(2), { timeout: WAIT_MS });
  gate.open();
  const results = await Promise.all(calls);
  expect(results.every((r) => !r.isError)).toBe(true);
}

describe('QueryPool trim delay (fake workers)', () => {
  it('a pool idle for the retirement time but not the trim time keeps its last worker untrimmed', async () => {
    // No idleShrinkMs: the trim delay is the default, far longer than this test waits.
    const gate = new Gate();
    const active = { count: 0 };
    const { pool, workers } = makePool({ size: 2, idleTimeoutMs: 5 }, async () => {
      active.count++;
      await gate.promise;
      active.count--;
      return ok('served');
    });
    await burstOfTwo(pool, gate, active);

    await vi.waitFor(() => expect(workers.filter((w) => w.retireReceived)).toHaveLength(1), { timeout: WAIT_MS });
    expect(pool.liveWorkers).toBe(1);
    // Twelve times the 5 ms retirement delay: a trim scheduled at that delay would have landed by now.
    await sleep(QUIET_MS);
    const survivor = workers.find((w) => !w.retireReceived)!;
    expect(survivor.trims).toBe(0);
  });

  it('the trim follows idleShrinkMs, after retirement', async () => {
    const gate = new Gate();
    const active = { count: 0 };
    const { pool, workers } = makePool({ size: 2, idleTimeoutMs: 5, idleShrinkMs: 400 }, async () => {
      active.count++;
      await gate.promise;
      active.count--;
      return ok('served');
    });
    await burstOfTwo(pool, gate, active);

    // Polled every millisecond, so the check runs right after the spare's 5 ms
    // retirement and well before the survivor's 400 ms trim.
    await vi.waitFor(() => expect(workers.some((w) => w.retireReceived)).toBe(true), { timeout: WAIT_MS, interval: 1 });
    const survivor = workers.find((w) => !w.retireReceived)!;
    expect(survivor.trims).toBe(0);
    await vi.waitFor(() => expect(survivor.trims).toBe(1), { timeout: WAIT_MS });
  });

  it('idleTimeoutMs 0 does not stop the trim of a pool that never grew', async () => {
    const { pool, workers } = makePool({ size: 1, idleTimeoutMs: 0, idleShrinkMs: 5 });
    const res = await pool.run('codegraph_search', { query: 'q' });
    expect(res.isError).toBeFalsy();
    expect(workers).toHaveLength(1);
    await vi.waitFor(() => expect(workers[0]!.trims).toBe(1), { timeout: WAIT_MS });
  });

  it('idleShrinkMs 0 never trims', async () => {
    const { pool, workers } = makePool({ size: 1, idleTimeoutMs: 5, idleShrinkMs: 0 });
    const res = await pool.run('codegraph_search', { query: 'q' });
    expect(res.isError).toBeFalsy();
    // idleShrinkMs is 0, so no trim is armed; twelve times the 5 ms delay the other tests use.
    await sleep(QUIET_MS);
    expect(workers[0]!.trims).toBe(0);
  });
});
