/**
 * Index-builder gates IB1-IB10.
 *
 * Each gate drives the built CLI's `serve --mcp` over stdio, as an agent host does, against throwaway git
 * repositories, with CODEGRAPH_STATE_DIR set per test. The gates assert only what is observable from outside:
 * the tool answers, `<state>/builder.pid` and `builder.log`, the lock files under each root's `.codegraph/`,
 * `<state>/server.pid`, and whether pids are alive. The helpers are in `machine-server.harness.ts`.
 *
 * Without a builder, the job waits are short. IB1-IB3 and IB5 record the missing builder and still run
 * their steps on short waits, so the run shows where each write lands. IB4 and IB6 fail on their own answers.
 * IB7 is a regression guard for the edit path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import {
  Fixtures,
  McpSession,
  SessionOptions,
  ToolAnswer,
  answers,
  builderLogLines,
  builderPidOf,
  excerpt,
  isAlive,
  lockFileHolders,
  serverPidOf,
  sleep,
  stopIfCodegraph,
  waitUntil,
} from './machine-server.harness';

const EXPLORE = 'codegraph_explore';
const STATUS = 'codegraph_status';
/** How long a builder may take to appear in builder.pid after its server starts. */
const BUILDER_APPEAR_MS = 180_000;
/** The lock sampler's period: the gate reads the lock files every ~20 ms. */
const SAMPLE_MS = 20;
/** How long a gate waits for one job line in builder.log: a small-repo job is seconds, the rest is headroom for heavily loaded scheduling. */
const JOB_WAIT_MS = 180_000;
/** The wait used for the same job lines when no builder exists: short, so the run stays quick. */
const NO_BUILDER_WAIT_MS = 10_000;
/** Job kinds whose end line means the root's working tree was synced (the fresh sync, the watcher, a catch-up). */
const SYNC_KINDS = ['sync', 'watch-sync', 'catch-up'];

/** One job line of builder.log: `job start` or `job end`, with its line index in the file. */
interface Job {
  index: number;
  edge: 'start' | 'end';
  kind: string;
  root: string;
  /** `ok` or `failed` on an end line; null on a start line. */
  status: string | null;
  msg: string;
}

/** One lock holder read from one root's lock files, stamped with the builder and server pids read on the same tick. */
interface HolderSample {
  root: string;
  file: string;
  pid: number;
  builderPid: number | null;
  serverPid: number | null;
}

interface LockSampler {
  holders: HolderSample[];
  ticks: number;
  stop: () => Promise<void>;
}

/** The job lines of builder.log, parsed. Non-job lines are skipped; each job keeps its file line index. */
function jobsOf(stateDir: string): Job[] {
  const jobs: Job[] = [];
  builderLogLines(stateDir).forEach((line, index) => {
    const m = /^\S+ job (start|end) (\S+) (.+)$/.exec(line);
    if (m === null) return;
    const edge = m[1] as 'start' | 'end';
    const kind = m[2]!;
    const rest = m[3]!;
    if (edge === 'start') {
      jobs.push({ index, edge, kind, root: rest, status: null, msg: '' });
      return;
    }
    const end = /^(.+?) (ok|failed)(?:: (.*))?$/.exec(rest);
    jobs.push(
      end === null
        ? { index, edge, kind, root: rest, status: null, msg: '' }
        : { index, edge, kind, root: end[1]!, status: end[2]!, msg: end[3] ?? '' },
    );
  });
  return jobs;
}

/** The first job at or after `fromIndex` that `pred` accepts, or undefined. */
function findJob(stateDir: string, fromIndex: number, pred: (job: Job) => boolean): Job | undefined {
  return jobsOf(stateDir).find((job) => job.index >= fromIndex && pred(job));
}

/** Waits, bounded, for a job at or after `fromIndex` that `pred` accepts; returns it, or undefined on timeout. */
async function waitForJob(
  stateDir: string,
  fromIndex: number,
  pred: (job: Job) => boolean,
  timeoutMs: number,
): Promise<Job | undefined> {
  await waitUntil(() => findJob(stateDir, fromIndex, pred) !== undefined, timeoutMs, 100);
  return findJob(stateDir, fromIndex, pred);
}

/**
 * Reads the lock files of every root in `roots` every SAMPLE_MS until stopped. Every holder it finds is kept with
 * the builder and server pids read on that tick, so each sample can be judged on its own.
 */
function startLockSampler(stateDir: string, roots: string[]): LockSampler {
  const sampler: LockSampler = { holders: [], ticks: 0, stop: async () => undefined };
  let running = true;
  const loop = (async () => {
    while (running) {
      sampler.ticks++;
      const builderPid = builderPidOf(stateDir);
      const serverPid = serverPidOf(stateDir);
      for (const root of roots) {
        for (const holder of lockFileHolders(root)) {
          sampler.holders.push({ root, file: holder.file, pid: holder.pid, builderPid, serverPid });
        }
      }
      await sleep(SAMPLE_MS);
    }
  })();
  sampler.stop = async () => {
    running = false;
    await loop;
  };
  return sampler;
}

/** One line per distinct holder that is not the builder: the server's pid, or a pid that is neither the builder's nor the server's. */
function foreignHolders(label: string, sampler: LockSampler): string[] {
  const counts = new Map<string, number>();
  for (const h of sampler.holders) {
    if (h.builderPid !== null && h.pid === h.builderPid) continue;
    const who = h.serverPid !== null && h.pid === h.serverPid ? 'the server' : 'a process that is not the builder';
    const key =
      `${label}: ${who} (pid ${h.pid}) holds ${h.file} of ${h.root} ` +
      `(builder pid ${h.builderPid ?? 'none'}, server pid ${h.serverPid ?? 'none'})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key}, ${n} samples`);
}

/** A one-line account of a sampler's counts, for the run's console output. */
function samplerCounts(sampler: LockSampler): string {
  const builderHeld = sampler.holders.filter((h) => h.builderPid !== null && h.pid === h.builderPid).length;
  return `${sampler.ticks} ticks, ${sampler.holders.length} holder samples, ${builderHeld} of them the builder's`;
}

describe('index builder gates (serve --mcp over stdio, throwaway repos)', () => {
  const fx = new Fixtures();
  /** Every state dir a test used; teardown reads their builder pids before the temp roots go. */
  const stateDirs: string[] = [];

  afterEach(async () => {
    const builders = stateDirs.map((dir) => builderPidOf(dir)).filter((pid): pid is number => pid !== null);
    stateDirs.length = 0;
    await fx.teardown();
    // A builder whose server is gone exits with its IPC channel; this stops one that did not.
    for (const pid of builders) await stopIfCodegraph(pid);
  }, 120_000);

  /** The per-test state dir under `root`, remembered for the teardown. */
  function stateDirUnder(root: string): string {
    const dir = path.join(root, 'state');
    stateDirs.push(dir);
    return dir;
  }

  /**
   * A session started with CODEGRAPH_AUTO_INDEX unset in its environment. The spawn copies the environment
   * synchronously, so the variable is restored at once.
   */
  function startSession(opts: SessionOptions): McpSession {
    const saved = process.env.CODEGRAPH_AUTO_INDEX;
    delete process.env.CODEGRAPH_AUTO_INDEX;
    try {
      return fx.session({ ...opts, env: {
        CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS: '180000',
        CODEGRAPH_DAEMON_RETRY_MS: '100', CODEGRAPH_DAEMON_RETRY_MAX_MS: '1000',
        CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: '0', CODEGRAPH_QUERY_WORKER_IDLE_TIMEOUT_MS: '0',
        CODEGRAPH_BUILDER_ENSURE_WAIT_MS: '110000', CODEGRAPH_FRESH_TIMEOUT_MS: '180000',
        ...opts.env,
      } });
    } finally {
      if (saved !== undefined) process.env.CODEGRAPH_AUTO_INDEX = saved;
    }
  }

  /** A probe job proves the server received ready without touching the gate's first-call root. */
  async function waitForBuilderReady(stateDir: string): Promise<void> {
    const probe = fx.makeRepo(path.join(fx.tempRoot(), 'probe'), {
      'src/probe.ts': 'export function readyProbe() { return "builder-ready-probe-marker"; }\n',
    });
    const session = startSession({ cwd: probe, stateDir });
    await session.initialize();
    await vi.waitFor(async () => {
      expect(answers(await session.tool(EXPLORE, { query: 'readyProbe', projectPath: probe }, JOB_WAIT_MS),
        'readyProbe', 'builder-ready-probe-marker')).toBe(true);
    }, { timeout: JOB_WAIT_MS, interval: 250 });
    expect(findJob(stateDir, 0, (job) => job.root === probe && job.kind === 'cold-build'
      && job.edge === 'end' && job.status === 'ok'), 'probe job completed through the server client').toBeDefined();
  }

  // IB1: every writer lock is the builder's. Across a cold build, a seed's catch-up and a sync after an edit, every
  // pid in the root's writer.pid, rebuild.pid and codegraph.lock is the builder's, never the server's.
  it('IB1: during a cold build, a seed catch-up and a sync, every lock holder is the builder, never the server', async () => {
    // Over 5 s by design: three repositories, two CLI index runs, three serve --mcp spawns, and three builder jobs waited on under load.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const r1 = fx.makeRepo(path.join(root, 'r1'), { 'src/r1.ts': 'export const ib1Base = 1;\n' });
    const x1 = fx.addWorktree(r1, 'ib1-x1', path.join(root, 'x1'));
    const r2 = fx.makeRepo(path.join(root, 'r2'), {
      'src/seed.ts': 'export function ib1SeedSymbol(): string {\n  return "ib1-seed-body-marker";\n}\n',
    });
    const w2 = fx.addWorktree(r2, 'ib1-w2', path.join(root, 'w2'));
    const r3 = fx.makeRepo(path.join(root, 'r3'), { 'src/sync.ts': 'export const ib1SyncBase = 1;\n' });
    fx.index(r2, stateDir);
    fx.index(r3, stateDir);
    const env = { CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS: '2000' };
    const sx = startSession({ cwd: x1, stateDir, env });
    const sw = startSession({ cwd: w2, stateDir, env });
    const sr = startSession({ cwd: r3, stateDir, env });
    await sx.initialize();
    await sw.initialize();
    await sr.initialize();

    const problems: string[] = [];
    const roots = [x1, w2, r3];
    const builderUp = await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!builderUp) {
      problems.push(`no builder.pid within ${BUILDER_APPEAR_MS / 1000} s of the server start: no builder exists to hold the writer locks`);
    }
    // The phases run either way: with no builder they wait the short bound, and the samples still show who holds the locks.
    const jobWait = builderUp ? JOB_WAIT_MS : NO_BUILDER_WAIT_MS;

    // Phase 1: cold build of X1, a worktree with no index and no sibling. The delay knob holds its rebuild.pid for 2 s.
    const coldSampler = startLockSampler(stateDir, roots);
    const coldFrom = builderLogLines(stateDir).length;
    const coldCall = await sx.tool(EXPLORE, { query: 'ib1ColdSymbol', projectPath: x1 }, JOB_WAIT_MS);
    const coldEnd = await waitForJob(stateDir, coldFrom, (j) => j.edge === 'end' && j.kind === 'cold-build' && j.root === x1, jobWait);
    await coldSampler.stop();
    if (coldEnd === undefined) {
      problems.push(`cold build of X1 did not end within ${jobWait / 1000} s (first call answered ${excerpt(coldCall)})`);
    } else if (coldEnd.status !== 'ok') {
      problems.push(`cold build of X1 ended ${coldEnd.status}: ${coldEnd.msg}`);
    }
    if (coldSampler.holders.length === 0) {
      problems.push(`cold build: sampled no lock holder at all in ${coldSampler.ticks} ticks during the cold build`);
    }
    problems.push(...foreignHolders('cold build', coldSampler));
    console.info(`IB1 cold build lock samples: ${samplerCounts(coldSampler)}`);

    // Phase 2: a seed of W2 (a sibling of an indexed repository), then its queued catch-up.
    const seedSampler = startLockSampler(stateDir, roots);
    const seedFrom = builderLogLines(stateDir).length;
    const seedCall = await sw.tool(EXPLORE, { query: 'ib1SeedSymbol', projectPath: w2 }, JOB_WAIT_MS);
    const seedEnd = await waitForJob(stateDir, seedFrom, (j) => j.edge === 'end' && j.kind === 'catch-up' && j.root === w2, jobWait);
    await seedSampler.stop();
    if (!answers(seedCall, 'ib1SeedSymbol', 'ib1-seed-body-marker')) {
      problems.push(`seed of W2: the first call did not answer from the copied index: ${excerpt(seedCall)}`);
    }
    if (seedEnd === undefined) {
      problems.push(`seed of W2: no catch-up job for W2 ended within ${jobWait / 1000} s`);
    } else if (seedEnd.status !== 'ok') {
      problems.push(`seed of W2: catch-up ended ${seedEnd.status}: ${seedEnd.msg}`);
    }
    problems.push(...foreignHolders('seed catch-up', seedSampler));
    console.info(`IB1 seed catch-up lock samples: ${samplerCounts(seedSampler)}`);

    // Phase 3: an edit in R3, then a fresh status call, which waits for the sync it queues.
    const syncSampler = startLockSampler(stateDir, roots);
    const syncFrom = builderLogLines(stateDir).length;
    fs.writeFileSync(
      path.join(r3, 'src', 'sync.ts'),
      'export const ib1SyncBase = 1;\nexport function ib1SyncEdit(): string {\n  return "ib1-sync-body-marker";\n}\n',
    );
    const freshCall = await sr.tool(STATUS, { projectPath: r3, fresh: true }, JOB_WAIT_MS);
    const syncEnd = await waitForJob(stateDir, syncFrom, (j) => j.edge === 'end' && SYNC_KINDS.includes(j.kind) && j.root === r3, jobWait);
    await syncSampler.stop();
    if (syncEnd === undefined) {
      problems.push(`sync after an edit: no sync job for R3 ended within ${jobWait / 1000} s (fresh call answered ${excerpt(freshCall)})`);
    } else if (syncEnd.status !== 'ok') {
      problems.push(`sync after an edit: ${syncEnd.kind} job for R3 ended ${syncEnd.status}: ${syncEnd.msg}`);
    }
    problems.push(...foreignHolders('sync after an edit', syncSampler));
    console.info(`IB1 sync lock samples: ${samplerCounts(syncSampler)}`);

    expect(problems, 'IB1 problems (empty when every lock holder is the builder, and the cold build sampled one)').toEqual([]);
  }, 600_000);

  // IB2: queue order. A sync of Z sent while cold build X runs waits for X to end, and runs before cold build Y starts.
  it('IB2: a sync sent while cold build X runs ends before cold build Y starts', async () => {
    // Over 5 s by design: three repositories, a CLI index run, three serve --mcp spawns, and two cold builds held open for 60 s each so requests can queue under heavy load.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const rx = fx.makeRepo(path.join(root, 'rx'), { 'src/x.ts': 'export const ib2XBase = 1;\n' });
    const x = fx.addWorktree(rx, 'ib2-x', path.join(root, 'x'));
    const ry = fx.makeRepo(path.join(root, 'ry'), { 'src/y.ts': 'export const ib2YBase = 1;\n' });
    const y = fx.addWorktree(ry, 'ib2-y', path.join(root, 'y'));
    const rz = fx.makeRepo(path.join(root, 'rz'), {
      'src/z.ts': 'export function ib2ZBase(): string {\n  return "ib2-z-base-marker";\n}\n',
    });
    fx.index(rz, stateDir);
    const env = { CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS: '60000' };
    const sz = startSession({ cwd: rz, stateDir, env });
    const sx = startSession({ cwd: x, stateDir, env });
    const sy = startSession({ cwd: y, stateDir, env });
    await sz.initialize();
    await sx.initialize();
    await sy.initialize();

    const problems: string[] = [];
    const builderUp = await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!builderUp) {
      problems.push(`no builder.pid within ${BUILDER_APPEAR_MS / 1000} s of the server start: no builder exists to queue the jobs`);
    }
    const jobWait = builderUp ? JOB_WAIT_MS : NO_BUILDER_WAIT_MS;

    // Z is held first, so the only Z work the window below sees is the sync the gate sends.
    await sz.tool(EXPLORE, { query: 'ib2ZBase', projectPath: rz }, JOB_WAIT_MS);
    const xCall = await sx.tool(EXPLORE, { query: 'ib2XOnly', projectPath: x }, JOB_WAIT_MS);
    const xStart = await waitForJob(stateDir, 0, (j) => j.edge === 'start' && j.kind === 'cold-build' && j.root === x, jobWait);
    if (xStart === undefined) {
      problems.push(`cold build of X never started within ${jobWait / 1000} s (first call answered ${excerpt(xCall)})`);
    } else {
      // Y's cold build is queued behind X: a cold-build job while X runs waits for it.
      await sy.tool(EXPLORE, { query: 'ib2YOnly', projectPath: y }, JOB_WAIT_MS);
      // The sync: an edit in Z, then a fresh status call. The window must be open when the call is sent (X started
      // and has not ended), so the sync is queued while X runs.
      fs.writeFileSync(
        path.join(rz, 'src', 'z.ts'),
        'export function ib2ZBase(): string {\n  return "ib2-z-base-marker";\n}\nexport function ib2ZEdit(): string {\n  return "ib2-z-edit-marker";\n}\n',
      );
      const xEndedBeforeSend = findJob(stateDir, xStart.index, (j) => j.edge === 'end' && j.kind === 'cold-build' && j.root === x);
      if (xEndedBeforeSend !== undefined) problems.push('X had already ended when the sync was sent: the window the gate needs was missed');
      const syncCall = await sz.tool(STATUS, { projectPath: rz, fresh: true }, JOB_WAIT_MS);
      if (syncCall.rpcError !== null) problems.push(`the fresh status call on Z answered a JSON-RPC error: ${excerpt(syncCall)}`);

      const isZSync = (j: Job, edge: 'start' | 'end'): boolean =>
        j.edge === edge && (j.kind === 'sync' || j.kind === 'watch-sync') && j.root === rz;
      const zEnd = await waitForJob(stateDir, xStart.index + 1, (j) => isZSync(j, 'end'), jobWait);
      const yStart = await waitForJob(
        stateDir,
        xStart.index + 1,
        (j) => j.edge === 'start' && j.kind === 'cold-build' && j.root === y,
        jobWait,
      );
      const all = jobsOf(stateDir);
      const xEnd = all.find((j) => j.index > xStart.index && j.edge === 'end' && j.kind === 'cold-build' && j.root === x);
      const zStart = all.find((j) => j.index > xStart.index && isZSync(j, 'start'));
      if (xEnd === undefined) problems.push('X never ended');
      if (zEnd === undefined) problems.push(`no sync job of Z ended within ${jobWait / 1000} s after X started`);
      if (yStart === undefined) problems.push(`Y's cold build never started within ${jobWait / 1000} s`);
      if (zEnd !== undefined && yStart !== undefined && zEnd.index > yStart.index) {
        problems.push(`Z's sync ended at builder.log line ${zEnd.index}, after Y's cold build started at line ${yStart.index}`);
      }
      if (zStart !== undefined && xEnd !== undefined && zStart.index < xEnd.index) {
        problems.push(`Z's sync started at line ${zStart.index}, before X ended at line ${xEnd.index}: a running job was preempted`);
      }
    }

    expect(problems, 'IB2 problems (empty when Z sync ends before Y cold build starts, and was sent while X ran)').toEqual([]);
  }, 600_000);

  // IB3: the builder is a restartable child. SIGKILL during a cold build leaves the server running, the server starts
  // a new builder, and the next call on the worktree answers from its index.
  it('IB3: after SIGKILL of the builder during a cold build, the server starts a new builder and the next call answers from the index', async () => {
    // Over 5 s by design: a cold build held open for 30 s to observe and kill its lock holder under load, a builder kill and restart, and polling calls on an overloaded machine.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'main'), { 'src/base.ts': 'export const ib3Base = 1;\n' });
    const wt = fx.addWorktree(repo, 'ib3-wt', path.join(root, 'wt'));
    fx.commitFiles(wt, { 'src/kill.ts': 'export function ib3KillSymbol(): string {\n  return "ib3-kill-body-marker";\n}\n' }, 'ib3: symbol');
    const session = startSession({ cwd: wt, stateDir, env: { CODEGRAPH_BUILDER_COLD_BUILD_DELAY_MS: '30000' } });
    await session.initialize();

    const problems: string[] = [];
    const builderUp = await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!builderUp) {
      problems.push(`no builder.pid within ${BUILDER_APPEAR_MS / 1000} s of the server start: no builder exists to kill`);
    }
    const jobWait = builderUp ? JOB_WAIT_MS : NO_BUILDER_WAIT_MS;

    const serverBefore = serverPidOf(stateDir);
    const firstCall = await session.tool(EXPLORE, { query: 'ib3KillSymbol', projectPath: wt }, JOB_WAIT_MS);
    const started = await waitForJob(stateDir, 0, (j) => j.edge === 'start' && j.kind === 'cold-build' && j.root === wt, jobWait);
    const killed = builderPidOf(stateDir);
    if (started === undefined) {
      problems.push(`no cold-build job started for the worktree within ${jobWait / 1000} s (first call answered ${excerpt(firstCall)})`);
    } else if (killed === null) {
      problems.push('a cold build started but builder.pid names no builder to kill');
    } else {
      // The cold build holds its locks while the delay runs: the builder's pid must be in one of them.
      if (!(await waitUntil(() => lockFileHolders(wt).some((h) => h.pid === killed), 180_000, 20))) {
        problems.push(`while the cold build ran, no lock under the worktree's .codegraph named builder pid ${killed}`);
      }
      try {
        process.kill(killed, 'SIGKILL');
      } catch (err) {
        problems.push(`could not SIGKILL builder pid ${killed}: ${String(err)}`);
      }
      const restarted = await waitUntil(() => {
        const pid = builderPidOf(stateDir);
        return pid !== null && pid !== killed && isAlive(pid);
      }, 180_000, 100);
      if (!restarted) {
        problems.push(`no new builder pid in builder.pid within 180 s of SIGKILL on ${killed} (builder.pid still ${builderPidOf(stateDir)})`);
      }
      const serverAfter = serverPidOf(stateDir);
      if (serverBefore === null || serverAfter !== serverBefore) {
        problems.push(`the server pid changed across the builder kill: ${serverBefore} -> ${serverAfter}`);
      }
      if (serverBefore !== null && !isAlive(serverBefore)) problems.push(`server pid ${serverBefore} is not running after the builder was killed`);

      // The next write on the worktree: call until one answers from its index.
      const deadline = Date.now() + 180_000;
      let last: ToolAnswer | undefined;
      let answered = false;
      while (!answered && Date.now() < deadline) {
        last = await session.tool(EXPLORE, { query: 'ib3KillSymbol', projectPath: wt }, JOB_WAIT_MS);
        answered = answers(last, 'ib3KillSymbol', 'ib3-kill-body-marker');
        if (!answered) await sleep(500);
      }
      if (!answered) {
        problems.push(`the next write on the worktree did not complete: no call answered from its index within 180 s (last answer ${last === undefined ? 'none' : excerpt(last)})`);
      }
    }

    expect(problems, 'IB3 problems (empty when the server restarted a builder and the worktree answers from its index)').toEqual([]);
  }, 600_000);

  // IB4: a worktree with no index, no sibling and no registration answers the building note first (success-shaped),
  // then answers from its own index once the cold build has finished.
  it('IB4: a worktree with no index and no sibling answers the building note first, then from its own index', async () => {
    // Over 5 s by design: a cold build of a worktree on an overloaded machine, a serve --mcp cold start, and polling calls until it finishes.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'main'), { 'src/base.ts': 'export const ib4Base = 1;\n' });
    const wt = fx.addWorktree(repo, 'ib4-wt', path.join(root, 'wt'));
    fx.commitFiles(wt, { 'src/ib4.ts': 'export function ib4Symbol(): string {\n  return "ib4-body-marker";\n}\n' }, 'ib4: symbol');
    const session = startSession({ cwd: wt, stateDir });
    await session.initialize();

    await waitForBuilderReady(stateDir);
    const problems: string[] = [];
    const first = await session.tool(EXPLORE, { query: 'ib4Symbol', projectPath: wt }, JOB_WAIT_MS);
    if (first.rpcError !== null || first.isError) {
      problems.push(`(1) the first call must be success-shaped, not an error: ${excerpt(first)}`);
    }
    if (!first.text.includes('is building the index')) {
      problems.push(`(1) the first call should answer the building note ("is building the index"): ${excerpt(first)}`);
    } else {
      const deadline = Date.now() + 180_000;
      let last: ToolAnswer = first;
      let answered = false;
      while (!answered && Date.now() < deadline) {
        await sleep(500);
        last = await session.tool(EXPLORE, { query: 'ib4Symbol', projectPath: wt }, JOB_WAIT_MS);
        answered = answers(last, 'ib4Symbol', 'ib4-body-marker');
      }
      if (!answered) {
        problems.push(`(2) no call on the worktree answered from its index within 180 s (last answer ${excerpt(last)})`);
      } else if (!fs.existsSync(path.join(wt, '.codegraph', 'codegraph.db'))) {
        problems.push(`(2) the answer did not come from the worktree's own index: ${path.join(wt, '.codegraph', 'codegraph.db')} is missing`);
      }
    }

    expect(problems, 'IB4 problems (empty when the first call is the building note and a later call answers from the worktree index)').toEqual([]);
  }, 600_000);

  // IB5: the builder has no idle exit. With the three idle timers at 1500 ms, the builder and the server are still
  // running 5 s after the last client closes.
  it('IB5: with the idle timers at 1500 ms, the builder and the server outlive the last client', async () => {
    // Over 5 s by design: a CLI index run, a serve --mcp cold start, and the 5 s wait after the client closes.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/idle.ts': 'export function ib5IdleSymbol(): string {\n  return "ib5-idle-body-marker";\n}\n',
    });
    fx.index(repo, stateDir);
    const session = startSession({
      cwd: repo,
      stateDir,
      env: {
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1500',
        CODEGRAPH_DAEMON_MAX_IDLE_MS: '1500',
        CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: '1500',
      },
    });
    await session.initialize();

    const problems: string[] = [];
    const ans = await session.tool(EXPLORE, { query: 'ib5IdleSymbol', projectPath: repo });
    if (!answers(ans, 'ib5IdleSymbol', 'ib5-idle-body-marker')) problems.push(`the call before the close did not answer: ${excerpt(ans)}`);
    const builder = (await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS)) ? builderPidOf(stateDir) : null;
    if (builder === null) problems.push(`no builder.pid within ${BUILDER_APPEAR_MS / 1000} s: there is no builder whose idle exit could be checked`);
    const server = serverPidOf(stateDir);
    if (server === null) problems.push(`no ${path.join(stateDir, 'server.pid')} naming a server pid`);

    await session.end();
    await sleep(5_000);
    if (builder !== null && !isAlive(builder)) problems.push(`builder pid ${builder} exited within 5 s after the last client closed (idle timers 1500 ms)`);
    if (server !== null && !isAlive(server)) problems.push(`server pid ${server} exited within 5 s after the last client closed (idle timers 1500 ms)`);

    expect(problems, 'IB5 problems (empty when the builder and the server are both running 5 s after the last client closed)').toEqual([]);
  }, 180_000);

  // IB6: a nested sub-project index inside a worktree does not shadow the worktree's own index. A call with a projectPath
  // in W/sub is answered from W's index, so a symbol that only W/other has is found.
  it('IB6: a call in a nested sub-project of a worktree is answered from the index of the worktree that holds it', async () => {
    // Over 5 s by design: a CLI index run of the worktree, an in-process index of its nested sub-project, a serve --mcp cold start and two tool calls on cold indexes.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'main'), { 'src/base.ts': 'export const ib6Base = 1;\n' });
    const w = fx.addWorktree(repo, 'ib6-w', path.join(root, 'w'));
    fx.commitFiles(
      w,
      {
        'other/w-only.ts': 'export function ib6WOnlySymbol(): string {\n  return "ib6-w-only-body-marker";\n}\n',
        'sub/src/inner.ts': 'export function ib6SubSymbol(): string {\n  return "ib6-sub-body-marker";\n}\n',
      },
      'ib6: worktree and a nested sub-project',
    );
    fx.index(w, stateDir);
    const sub = path.join(w, 'sub');
    // In this process, not through the CLI: `codegraph init <w>/sub` initializes the worktree root `w` (R-46).
    const subGraph = await CodeGraph.init(sub);
    try { await subGraph.indexAll(); } finally { subGraph.close(); }
    expect(fs.existsSync(path.join(sub, '.codegraph')), 'IB6 setup: the sub-project has its own index').toBe(true);
    const session = startSession({ cwd: w, stateDir });
    await session.initialize();

    const problems: string[] = [];
    const a = await session.tool(EXPLORE, { query: 'ib6WOnlySymbol', projectPath: sub }, JOB_WAIT_MS);
    if (!answers(a, 'ib6WOnlySymbol', 'ib6-w-only-body-marker')) {
      problems.push(`(a) projectPath ${sub} was not answered from the worktree's index (a symbol only the worktree has): ${excerpt(a)}`);
    }
    const b = await session.tool(EXPLORE, { query: 'ib6WOnlySymbol', projectPath: w }, JOB_WAIT_MS);
    if (!answers(b, 'ib6WOnlySymbol', 'ib6-w-only-body-marker')) {
      problems.push(`(b) control: projectPath ${w} did not answer its own symbol: ${excerpt(b)}`);
    }

    expect(problems, 'IB6 problems (empty when the sub-project call is answered from the worktree index)').toEqual([]);
  }, 600_000);

  // IB7: an edit reaches the read path. After an edit in a held root, a read through the server shows it within a
  // bounded wait. This is a regression guard for the edit path.
  it('IB7: an edit in a held root is visible to a read through the server within a bounded wait', async () => {
    // Over 5 s by design: a CLI index run, a serve --mcp cold start, and polling reads until the watcher's sync shows the edit.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/live.ts': 'export function ib7BeforeSymbol(): string {\n  return "ib7-before-body-marker";\n}\n',
    });
    fx.index(repo, stateDir);
    const session = startSession({ cwd: repo, stateDir });
    await session.initialize();

    const problems: string[] = [];
    const before = await session.tool(EXPLORE, { query: 'ib7BeforeSymbol', projectPath: repo }, JOB_WAIT_MS);
    if (!answers(before, 'ib7BeforeSymbol', 'ib7-before-body-marker')) {
      problems.push(`before the edit the call did not answer its symbol: ${excerpt(before)}`);
    }
    fs.writeFileSync(
      path.join(repo, 'src', 'live.ts'),
      'export function ib7BeforeSymbol(): string {\n  return "ib7-before-body-marker";\n}\n' +
        'export function ib7AfterSymbol(): string {\n  return "ib7-after-body-marker";\n}\n',
    );
    const deadline = Date.now() + 180_000;
    let last: ToolAnswer | undefined;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      last = await session.tool(EXPLORE, { query: 'ib7AfterSymbol', projectPath: repo }, JOB_WAIT_MS);
      seen = answers(last, 'ib7AfterSymbol', 'ib7-after-body-marker');
      if (!seen) await sleep(250);
    }
    if (!seen) {
      problems.push(`the edit is not visible through the server 180 s after it was written (last answer ${last === undefined ? 'none' : excerpt(last)})`);
    }

    expect(problems, 'IB7 problems (empty when the edit shows through the server within the bounded wait)').toEqual([]);
  }, 600_000);

  // IB8 (R-46): a directory that is not in a git worktree is never built. Each call on it, or on one of its
  // subdirectories, answers success-shaped that the path is not in a git repository; no build job starts and no
  // `.codegraph/` is created anywhere in it.
  it('IB8: a directory that is not a git worktree is not built, and the answer says it is not in a git repository', async () => {
    // Over 5 s by design: a serve --mcp cold start and a builder readiness probe on an overloaded machine.
    // The directory is a whole mkdtemp root (under os.tmpdir(), not os.tmpdir() itself); its state dir sits in a second root.
    const dir = fx.tempRoot();
    const stateDir = stateDirUnder(fx.tempRoot());
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'a.ts'), 'export function ib8PlainSymbol(): string {\n  return "ib8-plain-body-marker";\n}\n');
    const session = startSession({ cwd: dir, stateDir });
    await session.initialize();

    await waitForBuilderReady(stateDir);
    const problems: string[] = [];
    for (const projectPath of [dir, sub]) {
      const answer = await session.tool(EXPLORE, { query: 'ib8PlainSymbol', projectPath }, JOB_WAIT_MS);
      if (answer.rpcError !== null || answer.isError) {
        problems.push(`the call on ${projectPath} must be success-shaped, not an error: ${excerpt(answer)}`);
      }
      if (!answer.text.includes('is not in a git repository')) {
        problems.push(`the call on ${projectPath} should say it is not in a git repository: ${excerpt(answer)}`);
      }
      if (answer.text.includes('is building the index') || answer.text.includes('ib8-plain-body-marker')) {
        problems.push(`the call on ${projectPath} must neither build nor answer from an index: ${excerpt(answer)}`);
      }
    }
    for (const root of [dir, sub]) {
      if (fs.existsSync(path.join(root, '.codegraph'))) problems.push(`${path.join(root, '.codegraph')} was created`);
    }
    const builds = jobsOf(stateDir).filter((job) => job.kind === 'cold-build' && (job.root === dir || job.root === sub));
    if (builds.length > 0) problems.push(`a cold build was queued for the directory: ${JSON.stringify(builds)}`);

    expect(problems, 'IB8 problems (empty when no call builds and every answer says the path is not in a git repository)').toEqual([]);
  }, 600_000);

  // IB9: a git repository nested in an indexed checkout is its own build root. A session in it is answered building for
  // itself, never from the outer checkout's index (the outer one gitignores the repository and holds none of its files).
  // A session of the outer checkout asking about a nested repository gets the anchor guidance, and builds nothing there.
  it('IB9: a nested repository inside an indexed checkout is built for itself, and an outer session is guided away from it', async () => {
    // Over 5 s by design: a CLI index run of the outer checkout, a cold build of a small nested repository on an overloaded machine, and serve --mcp sessions polled until it answers.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const outer = fx.makeRepo(path.join(root, 'outer'), {
      '.gitignore': 'nested/\nnested2/\n',
      'src/outer.ts': 'export const ib9Outer = 1;\n',
    });
    fx.index(outer, stateDir);
    // Both nested repositories are created after the outer index: the outer index holds neither.
    const nested = fx.makeRepo(path.join(outer, 'nested'), {
      'src/nested.ts': 'export function ib9NestedSymbol(): string {\n  return "ib9-nested-body-marker";\n}\n',
    });
    const nested2 = fx.makeRepo(path.join(outer, 'nested2'), { 'src/other.ts': 'export const ib9Other = 2;\n' });
    const session = startSession({ cwd: nested, stateDir });
    await session.initialize();

    const problems: string[] = [];
    const seen: string[] = [];
    await waitForBuilderReady(stateDir);
    const first = await session.tool(EXPLORE, { query: 'ib9NestedSymbol', projectPath: nested }, JOB_WAIT_MS);
    seen.push(first.text);
    if (first.rpcError !== null || first.isError) {
      problems.push(`(1) the first call must be success-shaped, not an error: ${excerpt(first)}`);
    }
    if (!first.text.includes(`building the index for ${nested}`)) {
      problems.push(`(1) the first call should answer the building note naming ${nested} (not the outer index's refusal): ${excerpt(first)}`);
    }

    // Polled until the nested index answers with its body: a small repository is seconds, under load a minute or two.
    const deadline = Date.now() + 180_000;
    let last: ToolAnswer = first;
    let answered = false;
    while (!answered && Date.now() < deadline) {
      await sleep(500);
      last = await session.tool(EXPLORE, { query: 'ib9NestedSymbol', projectPath: nested }, JOB_WAIT_MS);
      seen.push(last.text);
      answered = answers(last, 'ib9NestedSymbol', 'ib9-nested-body-marker');
    }
    if (!answered) {
      problems.push(`(2) no call on ${nested} answered from its own index within 180 s (last answer ${excerpt(last)})`);
    }
    if (!fs.existsSync(path.join(nested, '.codegraph', 'codegraph.db'))) {
      problems.push(`(2) ${path.join(nested, '.codegraph', 'codegraph.db')} is missing: the nested repository has no index of its own`);
    }

    // The outer checkout's session. nested2 has no index and no build yet: the guidance must come back and nothing is built there.
    const outerSession = startSession({ cwd: outer, stateDir });
    await outerSession.initialize();
    for (const [label, projectPath] of [['nested2', nested2], ['nested', nested]] as const) {
      const guided = await outerSession.tool(EXPLORE, { query: 'ib9Other', projectPath }, JOB_WAIT_MS);
      seen.push(guided.text);
      if (guided.isError || guided.rpcError !== null) {
        problems.push(`(3) a path in ${label} must be answered success-shaped by the outer session: ${excerpt(guided)}`);
      }
      if (!guided.text.includes('answers only for the repository it was launched in')) {
        problems.push(`(3) the outer session should get the anchor guidance for ${label} (${projectPath}): ${excerpt(guided)}`);
      }
    }
    if (fs.existsSync(path.join(nested2, '.codegraph'))) {
      problems.push(`(4) the outer session created ${path.join(nested2, '.codegraph')}: nothing may be built for a path it is not anchored to`);
    }
    if (jobsOf(stateDir).some((j) => j.root.includes(nested2))) {
      problems.push(`(4) the builder ran a job for ${nested2}: ${jobsOf(stateDir).filter((j) => j.root.includes(nested2)).map((j) => `${j.kind} ${j.edge}`).join(', ')}`);
    }

    if (seen.some((text) => text.includes("user's decision"))) {
      problems.push('(5) an answer says indexing is the user\'s decision');
    }
    expect(problems, 'IB9 problems (empty when the nested repository is built for itself and the outer session is guided away from it)').toEqual([]);
  }, 600_000);

  // IB10: the instructions the server sends at initialize do not call indexing the user's decision, and still name codegraph init.
  it('IB10: the initialize instructions from serve --mcp do not call indexing the user\'s decision, and name codegraph init', async () => {
    // One serve --mcp cold start and one initialize: a spawn on an overloaded machine can pass 5 s, the bound is the answer's.
    const root = fx.tempRoot();
    const stateDir = stateDirUnder(root);
    const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/a.ts': 'export const ib10 = 1;\n' });
    const session = startSession({ cwd: repo, stateDir });
    await session.initialize();

    const instructions = session.instructions;
    expect(instructions, 'the initialize answer carries instructions').not.toBeNull();
    expect(instructions ?? '', 'the instructions name codegraph init').toContain('codegraph init');
    expect(instructions ?? '', 'the instructions do not call indexing the user\'s decision').not.toContain("user's decision");
  }, 120_000);
});
