/**
 * The pinned-project opener, in process (src/extensions/host/worktree-lifecycle/pinned-open.ts, wired in
 * src/mcp/engine.ts): a real MCPEngine built with `openPinned` and a stub builder that records what the engine asks of
 * it and answers as each case scripts. The gate (pinned-open.gate.test.ts) drives the built CLI over stdio. These cases
 * pin the engine's own choices one at a time, which a gate cannot reach: whether a housekeeping pass asks the builder
 * about a pinned root again, and what a stop does to a pinned open that is still waiting on the builder.
 *
 * A1 asserts that a pinned root whose first `ensure` answered `none` is asked about again by the next housekeeping
 * pass. The handler caches a root even when the builder recorded no hold for it, so an opener that skipped every
 * cached root would leave such a root open and never held; the opener skips a root only when it is cached AND the
 * builder reports it held, and A1 fails if a pass skips a cached root the builder does not hold.
 *
 * A4 asserts the stop path: an open still waiting on the builder's `ensure` when the engine stops must end with the root
 * out of the handler's cache and the builder's hold dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { MCPEngine } from '../../../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../../../src/mcp/tools';
import { canonicalProjectRoot } from '../../../src/directory';
import { pinProject } from '../../../src/extensions/host/worktree-lifecycle/project-registry';
import type { BuilderClient, BuilderFreshness, EnsureOutcome } from '../../../src/extensions/host/builder/client';

/** How a stub builder answers an `ensure`: `call` counts the calls for that root from 1. */
type EnsureAnswer = (root: string, call: number) => EnsureOutcome | Promise<EnsureOutcome>;

interface StubBuilder {
  /** The builder the engine is given. */
  builder: BuilderClient;
  /** Every builder call the engine made, in order: `ensure <root>`, `caughtUp <root>`, `sync <root>`, `release <root>`. */
  calls: string[];
  /** The canonical roots the builder holds: an `ensure` that answers `ready` holds its root, a `release` drops it. */
  held: Set<string>;
  /** How many `ensure` calls the engine made for `root`. */
  ensures(root: string): number;
}

/**
 * A builder that records what the engine asks of it and writes nothing. Its `ensure` answers as `answer` says;
 * `caughtUp`, `sync` and `release` resolve at once. Only a `ready` answer holds its root, the same rule the real
 * client's `record` follows: a `none` answer records no hold.
 */
function stubBuilder(answer: EnsureAnswer): StubBuilder {
  const calls: string[] = [];
  const held = new Set<string>();
  const ensureCalls = new Map<string, number>();
  const freshness = (root: string): BuilderFreshness => ({ root, watching: true, degradedReason: null, recovering: false, pendingFiles: [] });
  const builder = {
    ensure: async (projectPath: string): Promise<EnsureOutcome> => {
      const root = canonicalProjectRoot(projectPath);
      const call = (ensureCalls.get(root) ?? 0) + 1;
      ensureCalls.set(root, call);
      calls.push(`ensure ${root}`);
      const outcome = await answer(root, call);
      if (outcome.kind === 'ready') held.add(root);
      return outcome;
    },
    caughtUp: async (root: string): Promise<void> => {
      calls.push(`caughtUp ${canonicalProjectRoot(root)}`);
    },
    sync: async (root: string): Promise<{ filesChanged: number }> => {
      calls.push(`sync ${canonicalProjectRoot(root)}`);
      return { filesChanged: 0 };
    },
    release: async (root: string): Promise<void> => {
      const key = canonicalProjectRoot(root);
      calls.push(`release ${key}`);
      held.delete(key);
    },
    freshness: (root: string): BuilderFreshness | null => {
      const key = canonicalProjectRoot(root);
      return held.has(key) ? freshness(key) : null;
    },
  };
  return {
    builder: builder as unknown as BuilderClient,
    calls,
    held,
    ensures: (root: string) => ensureCalls.get(canonicalProjectRoot(root)) ?? 0,
  };
}

/** Polls `pred` every 20 ms until it holds or `timeoutMs` has passed. Returns whether it held. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A git-free project with one indexed TypeScript file, so the handler has an index to open. */
async function indexProject(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pinned.ts'), 'export function pinnedOpenUnitSymbol(): number {\n  return 1;\n}\n');
  const cg = await CodeGraph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg.indexAll();
  cg.close();
}

describe('pinned-open opener, in process, against a stub builder', { timeout: 60_000 }, () => {
  let workspace: string;
  let repo: string;
  const engines: MCPEngine[] = [];

  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pinned-open-unit-')));
    const stateDir = path.join(workspace, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // The registry lives under the state dir (project-registry.ts, registryDir). The housekeeping interval 0 means no
    // timer runs: a case runs its housekeeping pass itself with runHousekeepingTick.
    vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
    vi.stubEnv('CODEGRAPH_HOUSEKEEPING_INTERVAL_MS', '0');
    fs.mkdirSync(path.join(workspace, 'repo'));
    repo = fs.realpathSync(path.join(workspace, 'repo'));
    await indexProject(repo);
    pinProject(repo);
    __setLoadCodeGraphForTests(CodeGraph);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
    __setLoadCodeGraphForTests(null);
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  /** An engine that opens pinned projects, over `stub`, that the afterEach stops. */
  function startEngine(stub: StubBuilder): MCPEngine {
    const engine = new MCPEngine({ builder: stub.builder, openPinned: true });
    engines.push(engine);
    return engine;
  }

  /** True when the engine's handler caches `root` now. */
  function cached(engine: MCPEngine, root: string): boolean {
    return engine.getToolHandler().cachedProjectRoots().includes(canonicalProjectRoot(root));
  }

  // Over 5 s when the defect is present: the 10 s bound on the wait for the second ensure runs out, because the pass
  // that should ask again skips R. A passing run returns at once after that ensure; the bound only stops the wait.
  it('A1 (defect): a pinned root whose first ensure answered none is asked about again by the next housekeeping pass, not skipped as open', async () => {
    // The first ensure answers none and records no hold, as the client does when the builder is not up in time or the
    // IPC fails. Every later ensure answers ready and holds the root.
    const stub = stubBuilder((root, call) => (call === 1 ? { kind: 'none' } : { kind: 'ready', root }));
    const engine = startEngine(stub);
    const key = canonicalProjectRoot(repo);

    // Setup: the opener's first pass runs on the event loop's next turn. It asks the builder once, the handler still
    // opens and caches R, and the pass's catch-up call is the last step of that open.
    const firstPassOpened = await waitFor(() => stub.calls.includes(`caughtUp ${key}`) && cached(engine, repo), 10_000);
    expect(firstPassOpened, 'setup: the first pinned-open pass opened R (one ensure, then R cached and caught up)').toBe(true);
    expect(stub.ensures(repo), 'setup: the first pinned-open pass asked the builder once for R').toBe(1);
    expect(stub.held.has(key), 'setup: the builder holds nothing for R (its first ensure answered none)').toBe(false);

    // The housekeeping pass. Its opener pass is not awaited by the engine, so the wait for a second ensure is bounded.
    await engine.runHousekeepingTick();
    await waitFor(() => stub.ensures(repo) >= 2, 10_000);

    expect(
      stub.ensures(repo),
      `A1: the pass after housekeeping must ask the builder about R again, because R is open in the handler but the builder never recorded a hold for it; ` +
        `the builder was asked ${stub.ensures(repo)} time(s), so the opener skipped R as already open`,
    ).toBe(2);
    expect(stub.held.has(key), 'A1: the builder answered ready for R on that second ask, so it holds R').toBe(true);
  }, 30_000);

  it('A4: stopping the engine while a pinned root waits on the builder ensure closes R after the ensure answers and drops the hold', async () => {
    // The builder's answer for R is held back until the test gives it, so the open is still waiting when stop() runs.
    let answer!: (outcome: EnsureOutcome) => void;
    const pending = new Promise<EnsureOutcome>((resolve) => { answer = resolve; });
    const stub = stubBuilder(() => pending);
    const engine = startEngine(stub);
    const key = canonicalProjectRoot(repo);

    // Setup: the first pass is inside the open, waiting on the builder's ensure for R.
    const waiting = await waitFor(() => stub.ensures(repo) === 1, 10_000);
    expect(waiting, 'setup: the first pinned-open pass is waiting on the builder for R').toBe(true);
    expect(cached(engine, repo), 'setup: R is not cached while its ensure is unanswered').toBe(false);

    // stop() is not awaited: the engine closes while the open waits. Then the builder answers ready.
    const stopping = engine.stop();
    answer({ kind: 'ready', root: key });
    await stopping;

    const uncached = await waitFor(() => !cached(engine, repo), 10_000);
    expect(uncached, 'A4: R is still in the handler cache a bound after stop() and the ensure answer').toBe(true);
    const released = await waitFor(() => stub.calls.includes(`release ${key}`), 10_000);
    expect(released, `A4: the builder was not asked to release R after stop(); its calls were [${stub.calls.join(', ')}]`).toBe(true);
    expect(stub.held.has(key), 'A4: the builder still holds R after stop()').toBe(false);
  }, 30_000);
});
