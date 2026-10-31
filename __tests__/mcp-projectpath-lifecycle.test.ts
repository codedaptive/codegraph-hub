/**
 * `projectPath` project lifecycle (#1835).
 *
 * The engine has no default project: it serves every project through the
 * `projectPath` of a call. The engine only reads: each project's handle is
 * opened read-only, after the index builder holds that project's index (the
 * builder opens it writable, watches it, and queues its catch-up sync), the
 * first call waits (time-boxed) for the builder's catch-up, and the handle is
 * closed once idle (no count cap bounds how many stay open) and on stop(),
 * together with the builder's hold.
 *
 * Two groups. The first drives the engine against a stub builder that records
 * what the engine asks of it: the engine's own lifecycle (which calls ask the
 * builder what, which handles close when). The second runs a real builder
 * process behind the engine, for what only the builder does: catching an index
 * up, watching it, holding its writer slot, leaving a foreign writer alone,
 * and letting go of the slot when the engine does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { MCPEngine } from '../src/mcp/engine';
import { __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { BuilderClient, type BuilderFreshness, type EnsureOutcome } from '../src/extensions/host/builder/client';
import { ADMIT_ALL } from './helpers/admit-all';

// Read-only opens use the engine's lazy CommonJS loader.
const { MCPEngine: BuiltMCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');

const opened: CodeGraph[] = [];
let onOpen: ((cg: CodeGraph) => void) | undefined;
/** CodeGraph that records every instance the ToolHandler opens (and passes its options on: the open is read-only). */
class RecordingCodeGraph extends CodeGraph {
  static openSync(projectRoot: string, options?: Parameters<typeof CodeGraph.openSync>[1]): CodeGraph {
    const cg = CodeGraph.openSync(projectRoot, options);
    opened.push(cg);
    onOpen?.(cg);
    return cg;
  }
}

async function makeProject(dir: string, symbol: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), `export function ${symbol}() { return 1; }\n`);
  const cg = await CodeGraph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
  await cg.indexAll();
  cg.close();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** The function names an index holds, read through a read-only handle of our own. */
function names(root: string): string[] {
  const reader = CodeGraph.openSync(root, { readOnly: true });
  try { return reader.getNodesByKind('function').map((n) => n.name); }
  finally { reader.close(); }
}

/**
 * A builder that records what the engine asks of it and writes nothing. It reports a root as held (nothing
 * pending) from its `ensure` until its `release`; `catchUp` is the promise `caughtUp` waits on (held by a
 * test to model a catch-up still running); `ensureOutcome` overrides what `ensure` answers.
 */
function stubBuilder() {
  const calls: string[] = [];
  const held = new Set<string>();
  const control: { catchUp: Promise<void>; ensureOutcome: ((root: string) => EnsureOutcome) | null } = {
    catchUp: Promise.resolve(),
    ensureOutcome: null,
  };
  const fresh = (root: string): BuilderFreshness => ({ root, watching: true, degradedReason: null, recovering: false, pendingFiles: [] });
  const builder = {
    ensure: async (projectPath: string): Promise<EnsureOutcome> => {
      calls.push(`ensure ${projectPath}`);
      const outcome = control.ensureOutcome?.(projectPath) ?? { kind: 'ready' as const, root: projectPath };
      if (outcome.kind === 'ready') held.add(fs.realpathSync(projectPath));
      return outcome;
    },
    caughtUp: async (root: string) => { calls.push(`caughtUp ${root}`); await control.catchUp; },
    sync: async (root: string) => { calls.push(`sync ${root}`); return { filesChanged: 0 }; },
    release: async (root: string) => { calls.push(`release ${root}`); held.delete(fs.realpathSync(root)); },
    freshness: (root: string) => (held.has(fs.realpathSync(root)) ? fresh(root) : null),
  };
  return { calls, control, builder: builder as unknown as BuilderClient };
}

// Every case drives real opens and waits for them (see the gate note below),
// so each gets room for a loaded Windows VM; cases that do more set their own
// (#1773). These bounds only catch a hang.
describe('MCP explicit projectPath lifecycle (#1835), against a stub builder', { timeout: 30_000 }, () => {
  let workspace: string;
  let serviceA: string;
  let serviceB: string;
  let engine: MCPEngine;
  const engines: MCPEngine[] = [];
  const children: ChildProcess[] = [];
  const prevGate = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  let stub: ReturnType<typeof stubBuilder>;

  // Both hooks build indexes or wait out a sync; a loaded Windows VM exceeds
  // the default 10s hook timeout, and has taken over 30s (#1773).
  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1835-')));
    serviceA = path.join(workspace, 'service-a');
    serviceB = path.join(workspace, 'service-b');
    await makeProject(serviceA, 'alphaOriginal');
    await makeProject(serviceB, 'betaOriginal');
    // These cases assert what a call left behind, so wait for its catch-up
    // rather than the gate's 3s serve-anyway deadline, which a loaded machine
    // misses (#1773). That deadline has its own coverage in
    // mcp-catchup-gate.test.ts.
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    opened.length = 0;
    onOpen = undefined;
    __setLoadCodeGraphForTests(RecordingCodeGraph as unknown as typeof CodeGraph);
    stub = stubBuilder();
    engine = new MCPEngine({ builder: stub.builder });
    engines.push(engine);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.stop()));
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    }
    vi.restoreAllMocks();
    __setLoadCodeGraphForTests(null);
    if (prevGate === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prevGate;
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  async function search(projectPath: string, symbol: string): Promise<string> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query: symbol, projectPath }, undefined, ADMIT_ALL);
    expect(res.isError).toBeFalsy();
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  for (const withBuilder of [false, true]) {
    it(`defers explicit project opens during a rebuild (${withBuilder ? 'with a builder' : 'no builder'})`, async () => {
      await engine.stop();
      const rebuildAware = stubBuilder();
      // The builder answers `building` for a root a `codegraph index` rebuild holds, as the real one does.
      rebuildAware.control.ensureOutcome = (root) => (
        fs.existsSync(path.join(root, '.codegraph/rebuild.pid')) ? { kind: 'building', root } : { kind: 'ready', root }
      );
      engine = new BuiltMCPEngine(withBuilder ? { builder: rebuildAware.builder } : {});
      engines.push(engine);
      const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(holder);
      if (!holder.pid) throw new Error('Failed to spawn rebuild holder');
      const fence = path.join(serviceA, '.codegraph/rebuild.pid');
      fs.writeFileSync(fence, JSON.stringify({ pid: holder.pid, mode: 'rebuild', startedAt: Date.now() }));
      const response = await engine.getToolHandler().execute('codegraph_search', {
        projectPath: serviceA, query: 'alphaOriginal',
      }, undefined, ADMIT_ALL);
      expect(JSON.stringify(response)).toContain('rebuild is in progress');
      // Expected and temporary: guidance, never a tool error that teaches abandonment.
      expect(JSON.stringify(response)).not.toContain('"isError":true');
      expect(opened).toHaveLength(0);
      expect(fs.existsSync(path.join(serviceA, '.codegraph/writer.pid'))).toBe(false);
      fs.unlinkSync(fence);
      expect(await search(serviceA, 'alphaOriginal')).toContain('alphaOriginal');
    });
  }

  it('asks the builder to hold an index before the engine opens it, and waits for its catch-up', async () => {
    expect(await search(serviceA, 'alphaOriginal')).toContain('alphaOriginal');
    expect(stub.calls.slice(0, 2)).toEqual([`ensure ${serviceA}`, `caughtUp ${serviceA}`]);
    expect(opened).toHaveLength(1);
    // The engine's handle is read-only: it took no writer slot and no lock of its own.
    for (const lock of ['writer.pid', 'rebuild.pid', 'codegraph.lock']) {
      expect(fs.existsSync(path.join(serviceA, '.codegraph', lock)), lock).toBe(false);
    }
    expect(opened[0]!.isWatching()).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('keeps one instance per canonical root and closes it, and the builder\'s hold, on stop()', async () => {
    const link = path.join(workspace, 'link-to-b');
    fs.symlinkSync(serviceB, link, 'dir');
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(link, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(path.join(serviceB, 'src'), 'betaOriginal')).toContain('betaOriginal');
    expect(opened).toHaveLength(1);
    expect(stub.calls.filter((c) => c.startsWith('ensure'))).toEqual([`ensure ${serviceB}`]);

    await engine.stop();
    expect(() => opened[0]!.getStats()).toThrow();
    expect(stub.calls).toContain(`release ${serviceB}`);
  });

  it('shares the catch-up gate across concurrent calls', async () => {
    let release!: () => void;
    stub.control.catchUp = new Promise<void>((resolve) => { release = resolve; });
    let completed = 0;
    const calls = [
      search(serviceA, 'alphaOriginal'),
      search(path.join(serviceA, 'src'), 'alphaOriginal'),
      search(serviceA, 'alphaOriginal'),
    ].map((p) => p.then((r) => { completed++; return r; }));
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(completed).toBe(0);
      expect(opened).toHaveLength(1);
    } finally { release(); }
    await Promise.all(calls);
    expect(stub.calls.filter((c) => c.startsWith('caughtUp'))).toEqual([`caughtUp ${serviceA}`]);
    expect(opened).toHaveLength(1);
  });

  it('defers shutdown until an active catch-up finishes', async () => {
    let release!: () => void;
    stub.control.catchUp = new Promise<void>((resolve) => { release = resolve; });
    const prev = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '10';
    try {
      await search(serviceA, 'alphaOriginal');
      expect(() => opened[0]!.getStats()).not.toThrow();
      let stopped = false;
      const stop = engine.stop().then(() => { stopped = true; });
      await new Promise((r) => setTimeout(r, 50));
      expect(stopped).toBe(false);
      expect(() => opened[0]!.getStats()).not.toThrow();
      release();
      await stop;
      expect(() => opened[0]!.getStats()).toThrow();
      expect(stub.calls).toContain(`release ${serviceA}`);
    } finally {
      release();
      if (prev === undefined) delete process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
      else process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = prev;
    }
  }, 60_000);

  // A server that answered one projectPath query must not keep that project's
  // writer lock until it exits: `codegraph index` there would stay locked out
  // (#2087). The lock is the builder's; the engine's idle release is what has
  // the builder let go of it.
  it('releases an idle explicit project and the builder\'s hold on it, and asks again on the next call', async () => {
    const prev = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '200';
    try {
      expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
      expect(stub.calls.filter((c) => c.startsWith('ensure'))).toHaveLength(1);

      expect(await waitFor(async () => stub.calls.includes(`release ${serviceB}`), 10000)).toBe(true);
      expect(() => opened[0]!.getStats()).toThrow();

      // Still served while in use: the next call reopens and has the builder hold it again.
      expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
      expect(opened).toHaveLength(2);
      expect(stub.calls.filter((c) => c.startsWith('ensure'))).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = prev;
    }
  });

  it('defers an idle release until an active catch-up finishes (#2087)', async () => {
    let release!: () => void;
    stub.control.catchUp = new Promise<void>((resolve) => { release = resolve; });
    const prevIdle = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '50';
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '10';
    try {
      await search(serviceB, 'betaOriginal');
      await new Promise((r) => setTimeout(r, 300));
      expect(() => opened[0]!.getStats()).not.toThrow();
      expect(stub.calls).not.toContain(`release ${serviceB}`);
      release();
      expect(await waitFor(async () => stub.calls.includes(`release ${serviceB}`), 10000)).toBe(true);
      expect(() => opened[0]!.getStats()).toThrow();
    } finally {
      release();
      if (prevIdle === undefined) delete process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;
      else process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = prevIdle;
    }
  });

  it('drains a tool operation before closing its cached graph', async () => {
    await search(serviceA, 'alphaOriginal');
    const handler = engine.getToolHandler();
    const dispatch = handler.executeReadTool.bind(handler);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(handler, 'executeReadTool').mockImplementation(async (...args) => {
      await held;
      return dispatch(...args);
    });
    const call = search(serviceA, 'alphaOriginal');
    let stopped = false;
    const stop = engine.stop().then(() => { stopped = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      expect(opened[0]!.getStats().fileCount).toBe(1);
    } finally { release(); }
    await call;
    await stop;
    expect(() => opened[0]!.getStats()).toThrow();
  });
});

// The builder is a real process here: what it holds, watches and catches up is
// observed on disk, through a read-only handle of our own.
describe('MCP explicit projectPath lifecycle (#1835), behind a real builder', { timeout: 60_000 }, () => {
  let workspace: string;
  let serviceA: string;
  let serviceB: string;
  let engine: MCPEngine;
  let builder: BuilderClient;
  const prevDebounce = process.env.CODEGRAPH_WATCH_DEBOUNCE_MS;
  const prevGate = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  const prevIdle = process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS;

  beforeEach(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1835b-')));
    serviceA = path.join(workspace, 'service-a');
    serviceB = path.join(workspace, 'service-b');
    await makeProject(serviceA, 'alphaOriginal');
    await makeProject(serviceB, 'betaOriginal');
    // The builder inherits these when it starts.
    process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = '100';
    process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS = '0';
    opened.length = 0;
    onOpen = undefined;
    __setLoadCodeGraphForTests(RecordingCodeGraph as unknown as typeof CodeGraph);
    builder = BuilderClient.start();
    engine = new MCPEngine({ builder });
  }, 60_000);

  afterEach(async () => {
    await engine.stop();
    await builder.stop();
    __setLoadCodeGraphForTests(null);
    for (const [name, prev] of [
      ['CODEGRAPH_WATCH_DEBOUNCE_MS', prevDebounce],
      ['CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS', prevGate],
      ['CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS', prevIdle],
    ] as const) {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60_000);

  async function search(projectPath: string, symbol: string): Promise<string> {
    const res = await engine.getToolHandler().execute('codegraph_search', { query: symbol, projectPath }, undefined, ADMIT_ALL);
    expect(res.isError).toBeFalsy();
    return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  const writerLock = (root: string): { pid: number; mode: string } =>
    JSON.parse(fs.readFileSync(path.join(root, '.codegraph/writer.pid'), 'utf8')) as { pid: number; mode: string };

  it('catches up an edit made before the first call, and watches later edits', async () => {
    // Edited while no builder held the index — the catch-up path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaRenamed() { return 1; }\n');
    const first = await search(serviceA, 'alphaRenamed');
    expect(first).toContain('alphaRenamed');
    expect(names(serviceA)).toContain('alphaRenamed');
    expect(names(serviceA)).not.toContain('alphaOriginal');
    expect(first).not.toContain('alphaOriginal');
    // The engine's handle never watches; the builder does, and holds the writer slot.
    expect(opened).toHaveLength(1);
    expect(opened[0]!.isWatching()).toBe(false);
    expect(writerLock(serviceA).pid).toBe(builder.pid());
    expect(writerLock(serviceA).pid).not.toBe(process.pid);
    expect(writerLock(serviceA).mode).toBe('builder');

    // Edited while the project stays held — the watcher path.
    fs.writeFileSync(path.join(serviceA, 'src', 'sample.ts'), 'export function alphaWatched() { return 1; }\n');
    expect(await waitFor(async () => names(serviceA).includes('alphaWatched'), 20000)).toBe(true);
  });

  it('catches up both children', async () => {
    for (const [root, symbol] of [[serviceA, 'alphaNew'], [serviceB, 'betaNew']]) {
      fs.writeFileSync(path.join(root!, 'src/sample.ts'), `export function ${symbol}() {}\n`);
      await search(root!, symbol!);
      expect(names(root!)).toEqual([symbol]);
    }
  });

  it.runIf(process.platform !== 'win32')('holds one root once however it is spelled, and frees its writer slot when the engine stops', async () => {
    const link = path.join(workspace, 'link-to-b');
    fs.symlinkSync(serviceB, link, 'dir');
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(link, 'betaOriginal')).toContain('betaOriginal');
    expect(await search(path.join(serviceB, 'src'), 'betaOriginal')).toContain('betaOriginal');
    expect(opened).toHaveLength(1);
    expect(writerLock(serviceB).pid).toBe(builder.pid());

    await engine.stop();
    expect(() => opened[0]!.getStats()).toThrow();
    // engine.stop resolves after the builder let go: the slot is free for a CLI at once.
    expect(fs.existsSync(path.join(serviceB, '.codegraph', 'writer.pid'))).toBe(false);
  });

  it('does not take over a project another live process is already syncing, and takes it when that process lets go', async () => {
    const lock = path.join(serviceA, '.codegraph/writer.pid');
    const foreign = { pid: process.ppid, mode: 'direct', startedAt: Date.now() };
    fs.writeFileSync(lock, JSON.stringify(foreign));
    expect(await search(serviceA, 'alphaOriginal')).toContain('alphaOriginal');
    // Not ours — left in place, and served from the shared WAL meanwhile.
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.ppid);

    fs.writeFileSync(path.join(serviceA, 'src/sample.ts'), 'export function afterOwnerExit() {}\n');
    fs.unlinkSync(lock);
    // No further call should be necessary: the builder retries the slot, then catches the index up.
    expect(await waitFor(async () => names(serviceA).includes('afterOwnerExit'), 30000)).toBe(true);
    expect(writerLock(serviceA).pid).toBe(builder.pid());
  });

  // A server that answered one projectPath query must not keep that project's
  // writer lock until it exits: `codegraph index` there would stay locked out (#2087).
  it('frees the writer slot of an idle explicit project, and holds it again on the next call', async () => {
    process.env.CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS = '200';
    const lock = path.join(serviceB, '.codegraph/writer.pid');
    expect(await search(serviceB, 'betaOriginal')).toContain('betaOriginal');
    expect(writerLock(serviceB).pid).toBe(builder.pid());

    expect(await waitFor(async () => !fs.existsSync(lock), 20000)).toBe(true);
    expect(() => opened[0]!.getStats()).toThrow();

    // Still synchronized while in use: the next call reopens, and the builder holds and catches up again.
    fs.writeFileSync(path.join(serviceB, 'src/sample.ts'), 'export function afterIdleRelease() {}\n');
    expect(await search(serviceB, 'afterIdleRelease')).toContain('afterIdleRelease');
    expect(opened).toHaveLength(2);
    expect(writerLock(serviceB).pid).toBe(builder.pid());
  });
});
