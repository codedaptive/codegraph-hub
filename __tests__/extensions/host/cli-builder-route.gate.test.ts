/**
 * CLI routing gates G1-G6: the CLI's index writes (`init`, `index`, `sync`, and the `--fresh` wait of
 * `checkpoint`) through the machine server's builder.
 *
 * With a machine server and its builder running for the state dir, each write must run as a builder job, relayed
 * by the server, and the CLI process must hold no lock on the root. With none running, the CLI writes in its own
 * process as it does today, and creates no server.pid or builder.pid.
 *
 * Each gate drives the built CLI (dist/bin/codegraph.js, built by the suite's global setup) as a child process,
 * non-TTY, with CODEGRAPH_STATE_DIR set. The gates read only what is observable from outside: the exit code,
 * stdout and stderr, builder.log, the lock files under each root's .codegraph/, the pid files in the state dir,
 * and the answers of `codegraph query`. G4 and G5 speak the server's JSON-RPC on its socket, as the CLI does.
 * The helpers that start servers and read the lock files are in machine-server.harness.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import {
  BIN,
  Fixtures,
  builderLogLines,
  builderPidOf,
  gateEnv,
  isAlive,
  lockFileHolders,
  serverPidOf,
  sleep,
  stopIfCodegraph,
  waitUntil,
} from './machine-server.harness';

/** How long a builder may take to appear in builder.pid after the server starts. */
const BUILDER_APPEAR_MS = 15_000;
/** The lock sampler's period, as in index-builder.gate.test.ts. */
const SAMPLE_MS = 20;
/**
 * How long a routed command's job may take to write its end line after the CLI exited. The end line is the
 * builder's; the CLI's reply is the server's. A small repository is seconds; the rest is headroom at load 7-11.
 */
const JOB_END_WAIT_MS = 30_000;
/** How long a raw connection waits for the reply to an index request: a cold rebuild of a small repository, under load. */
const REPLY_MS = 120_000;
/** How long the lease's locks may take to go after its control connection closes. */
const LEASE_RELEASE_MS = 15_000;
/** The bound on one CLI run: a run that never ends fails here instead of hanging the file. */
const CLI_RUN_MS = 240_000;
/**
 * The JSON-RPC code of a refused codegraph/indexWrite (InvalidRequest, src/mcp/transport.ts ErrorCodes). The tree
 * without the route answers MethodNotFound (-32601) instead, so the G4 gates fail there.
 */
const REFUSED_CODE = -32600;

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

/** One lock holder read from a root's lock files, stamped with the builder and server pids read on the same tick. */
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

/** One CLI run: its exit status, its whole stdout and stderr, and the pid of the process (the pid any lock it takes names). */
interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
}

/** A JSON-RPC message from the server: a reply (with an id) or a notification (without one). */
interface RpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
}

/** A raw connection to the server's socket, after its hello. */
interface RawPeer {
  send: (msg: unknown) => void;
  reply: (id: number, timeoutMs: number) => Promise<RpcMessage>;
  destroy: () => void;
}

/** A one-function TypeScript file body. The function's name is what `codegraph query` finds. */
function fn(name: string): string {
  return `export function ${name}(): number {\n  return 1;\n}\n`;
}

/** Appends one function to a file of `repo`, uncommitted: an edit the next sync or checkpoint must see. */
function appendFn(repo: string, rel: string, name: string): void {
  fs.appendFileSync(path.join(repo, rel), fn(name));
}

/** The last 400 characters of a text, for a failure message. */
function tail(text: string): string {
  const t = text.trim();
  return t.length > 400 ? `...${t.slice(-400)}` : t;
}

/** The job lines of builder.log in file order. Non-job lines are skipped; each job keeps its file line index. */
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

/** Waits, bounded, for a job at or after `fromIndex` that `pred` accepts. Undefined on timeout. */
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
 * Problems with one routed command's builder job: a `job start <kind> <root>` line at or after `from`, and then
 * its `job end <kind> <root> ok` line. Without the start line, the command did not run as a builder job.
 */
async function jobProblems(stateDir: string, label: string, from: number, kind: string, root: string): Promise<string[]> {
  const start = findJob(stateDir, from, (j) => j.edge === 'start' && j.kind === kind && j.root === root);
  if (start === undefined) {
    return [
      `${label}: builder.log has no "job start ${kind} ${root}" line at or after line ${from}, ` +
        'so the command did not run as a builder job',
    ];
  }
  const end = await waitForJob(
    stateDir,
    start.index + 1,
    (j) => j.edge === 'end' && j.kind === kind && j.root === root,
    JOB_END_WAIT_MS,
  );
  if (end === undefined) {
    return [`${label}: no "job end ${kind} ${root}" line within ${JOB_END_WAIT_MS / 1000} s of its start`];
  }
  if (end.status !== 'ok') return [`${label}: the ${kind} job for ${root} ended ${String(end.status)}: ${end.msg}`];
  return [];
}

/**
 * Reads the lock files of every root in `roots` every SAMPLE_MS until stopped. Each holder is kept with the
 * builder and server pids read on the same tick, so every sample is judged on its own.
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

/**
 * One problem line per distinct holder that is not the builder, naming the CLI process when it is the holder.
 * `requireSamples` is for the commands whose job holds the lock for seconds (init, index): a sampler that saw
 * no holder at all proves nothing, so it is a problem there. A sync is short, and its samples are reported only.
 */
function holderProblems(
  label: string,
  sampler: LockSampler,
  cliPid: number | undefined,
  requireSamples: boolean,
): string[] {
  const problems: string[] = [];
  console.info(`${label} lock samples: ${sampler.ticks} ticks, ${sampler.holders.length} holder samples`);
  if (requireSamples && sampler.holders.length === 0) {
    problems.push(`${label}: sampled no lock holder in ${sampler.ticks} ticks, so the lock check proves nothing`);
  }
  const counts = new Map<string, number>();
  for (const h of sampler.holders) {
    if (h.builderPid !== null && h.pid === h.builderPid) continue;
    const who =
      h.pid === cliPid
        ? 'the CLI process'
        : h.serverPid !== null && h.pid === h.serverPid
          ? 'the server'
          : 'a process that is not the builder';
    const key = `${label}: ${who} (pid ${h.pid}) holds ${h.file} of ${h.root} (builder pid ${h.builderPid ?? 'none'})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, n] of counts) problems.push(`${key}, ${n} samples`);
  return problems;
}

/** Runs `dist/bin/codegraph.js` with `args` as a child of this process: non-TTY, the gate environment, `stateDir` set. */
function runCli(args: string[], stateDir: string, cwd: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...args], {
      cwd,
      env: gateEnv(stateDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const pid = child.pid;
    const finish = (status: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, pid });
    };
    const timer = setTimeout(() => {
      stderr += `\n[gate] no exit within ${CLI_RUN_MS / 1000} s; killed`;
      child.kill('SIGKILL');
      finish(null);
    }, CLI_RUN_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      stderr += `\n${String(err)}`;
      finish(null);
    });
    child.on('close', (status) => finish(status));
  });
}

/** Problems with a CLI run's exit status: exit 0 unless the gate says otherwise. */
function exitProblems(label: string, run: CliRun): string[] {
  return run.status === 0
    ? []
    : [`${label} exited ${String(run.status)} (expected 0): stderr ${JSON.stringify(tail(run.stderr))}`];
}

/**
 * Problems with `codegraph query <symbol> -p <repo> --json`: exit 0, JSON, and a result named `symbol`. The query
 * reads the index in-process, so a symbol it finds is an index that holds the write's effect.
 */
async function findsSymbol(stateDir: string, cwd: string, repo: string, symbol: string): Promise<string[]> {
  const run = await runCli(['query', symbol, '-p', repo, '--json'], stateDir, cwd);
  if (run.status !== 0) return [`codegraph query ${symbol} in ${repo} exited ${String(run.status)}: ${tail(run.stderr)}`];
  let results: unknown;
  try {
    results = JSON.parse(run.stdout);
  } catch {
    return [`codegraph query ${symbol} in ${repo} printed no JSON: ${tail(run.stdout)}`];
  }
  const names = Array.isArray(results)
    ? results.map((r) => (r as { node?: { name?: unknown } }).node?.name)
    : [];
  return names.includes(symbol)
    ? []
    : [`codegraph query ${symbol} in ${repo} does not find the symbol (names found: ${JSON.stringify(names)})`];
}

/**
 * CLI output after normalising what differs between two runs of the same content: ANSI escapes, the repository
 * path (replaced with <ROOT>), the checkpoint's head and dirty hashes, and durations and timings.
 */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
function normalise(text: string, repo: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(ANSI_ESCAPE, '')
    .split(repo)
    .join('<ROOT>')
    .replace(/head=[0-9a-f]{40}\b/g, 'head=<HEAD>')
    .replace(/dirty=[0-9a-f]{64}\b/g, 'dirty=<DIRTY>')
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<T>');
}

/** The socket path the server's `server.pid` names, or null when the record is absent or unreadable. */
function socketPathOf(stateDir: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8')) as { socketPath?: unknown };
    return typeof record.socketPath === 'string' && record.socketPath !== '' ? record.socketPath : null;
  } catch {
    return null;
  }
}

/**
 * Opens a raw connection to the server's socket: reads the server hello, sends `clientHello` as the client hello
 * when it is given (none when null: a legacy client), and resolves once the hello is through. Requests are sent
 * with `send`; replies are read with `reply`, by id.
 */
function openRaw(socketPath: string, clientHello: Record<string, unknown> | null): Promise<RawPeer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let buf = '';
    let helloSeen = false;
    const received = new Map<number, RpcMessage>();
    const waiters = new Map<number, (msg: RpcMessage) => void>();
    const peer: RawPeer = {
      send: (msg) => {
        socket.write(JSON.stringify(msg) + '\n');
      },
      reply: (id, timeoutMs) =>
        new Promise((res, rej) => {
          const got = received.get(id);
          if (got !== undefined) {
            res(got);
            return;
          }
          const timer = setTimeout(() => {
            waiters.delete(id);
            rej(new Error(`no reply to request ${id} within ${timeoutMs} ms`));
          }, timeoutMs);
          waiters.set(id, (msg) => {
            clearTimeout(timer);
            waiters.delete(id);
            res(msg);
          });
        }),
      destroy: () => {
        socket.destroy();
      },
    };
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === '') continue;
        if (!helloSeen) {
          helloSeen = true;
          let hello: { protocol?: unknown; codegraph?: unknown } = {};
          try {
            hello = JSON.parse(line) as typeof hello;
          } catch {
            /* judged below */
          }
          if (hello.protocol !== 1 || typeof hello.codegraph !== 'string') {
            socket.destroy();
            reject(new Error(`the first line is not the server hello: ${line.slice(0, 200)}`));
            return;
          }
          if (clientHello !== null) socket.write(JSON.stringify(clientHello) + '\n');
          resolve(peer);
          continue;
        }
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (typeof msg.id !== 'number') continue;
        const waiter = waiters.get(msg.id);
        if (waiter !== undefined) waiter(msg);
        else received.set(msg.id, msg);
      }
    });
    socket.on('error', (err) => {
      if (!helloSeen) reject(err);
    });
    socket.on('close', () => {
      if (!helloSeen) reject(new Error('the connection closed before the server hello'));
    });
  });
}

/** Whether a codegraph/indexWrite result is the routed answer (`{routed: true, ...}`). */
function isRouted(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { routed?: unknown }).routed === true;
}

/** The lock holders of the index lease under `repo`: a rebuild.pid or writer.pid naming a live pid. */
function leaseHolders(repo: string): Array<{ file: string; pid: number }> {
  return lockFileHolders(repo).filter((h) => (h.file === 'rebuild.pid' || h.file === 'writer.pid') && isAlive(h.pid));
}

/** A pid that names no running process: a child that has exited and been reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  if (child.pid === undefined) throw new Error('could not spawn a child to take a dead pid from');
  return child.pid;
}

describe('CLI index writes route through the running machine server (G1, G3, G4, G5)', () => {
  const fx = new Fixtures();
  /** Every state dir the describe used; teardown reads their builder pids before the temp roots go. */
  const stateDirs: string[] = [];

  let root = '';
  /** The state dir the server runs in. */
  let stateDir = '';
  /** The state dir of the in-process twin (G3): no server runs in it. */
  let stateB = '';
  let R1 = '';
  let R2 = '';
  let R3 = '';
  let R4a = '';
  let R4b = '';
  let R5 = '';
  let R6 = '';
  let TA = '';
  let TB = '';
  /** Set in beforeAll when the setup did not reach a running builder or server; every gate reports it. */
  let builderProblems: string[] = [];
  let serverProblems: string[] = [];

  /** A serve --mcp session with CODEGRAPH_AUTO_INDEX unset: the spawn copies the environment, so it is restored at once. */
  function startSession(cwd: string, state: string) {
    const saved = process.env.CODEGRAPH_AUTO_INDEX;
    delete process.env.CODEGRAPH_AUTO_INDEX;
    try {
      return fx.session({ cwd, stateDir: state });
    } finally {
      if (saved !== undefined) process.env.CODEGRAPH_AUTO_INDEX = saved;
    }
  }

  // Setup for G1, G3, G4 and G5, not a gate: a dozen throwaway repositories, four in-process index builds (the CLI's
  // write as it is today, before any server exists), and a serve --mcp cold start with its builder.
  beforeAll(async () => {
    root = fx.tempRoot();
    stateDir = path.join(root, 'state');
    stateB = path.join(root, 'state-b');
    stateDirs.push(stateDir, stateB);
    const r0 = fx.makeRepo(path.join(root, 'r0'), { 'src/session.ts': fn('g1Session') });
    R1 = fx.makeRepo(path.join(root, 'r1'), { 'src/one.ts': fn('g1InitBase') });
    R2 = fx.makeRepo(path.join(root, 'r2'), { 'src/two.ts': fn('g1SyncBase') });
    R3 = fx.makeRepo(path.join(root, 'r3'), { 'src/three.ts': fn('g1IndexBase') });
    R4a = fx.makeRepo(path.join(root, 'r4a'), { 'src/four.ts': fn('g4aBase') });
    R4b = fx.makeRepo(path.join(root, 'r4b'), { 'src/four.ts': fn('g4bBase') });
    R5 = fx.makeRepo(path.join(root, 'r5'), { 'src/five.ts': fn('g5Base') });
    R6 = fx.makeRepo(path.join(root, 'r6'), { 'src/six.ts': fn('g1FreshBase') });
    TA = fx.makeRepo(path.join(root, 'twin-a'), { 'src/twin.ts': fn('g3Twin') });
    TB = fx.makeRepo(path.join(root, 'twin-b'), { 'src/twin.ts': fn('g3Twin') });
    // Indexed in-process before the server starts. R1, R4a, R4b, TA and TB stay un-indexed: their gates index them.
    for (const repo of [R2, R3, R5, R6]) fx.index(repo, stateDir);

    // The session's cwd (r0) is never touched by any gate: it only starts the server and its builder.
    const session = startSession(r0, stateDir);
    await session.initialize();
    const builderUp = await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!builderUp) {
      builderProblems = [
        `no builder.pid within ${BUILDER_APPEAR_MS / 1000} s of the server start: no builder runs for the state dir, ` +
          'so no CLI write can be routed to one',
      ];
    }
    const serverUp = await waitUntil(() => serverPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!serverUp) serverProblems = [`no server.pid naming a server pid in ${stateDir}`];
  }, 600_000);

  afterAll(async () => {
    const builders = stateDirs.map((dir) => builderPidOf(dir)).filter((pid): pid is number => pid !== null);
    stateDirs.length = 0;
    await fx.teardown();
    // A builder whose server is gone exits with its IPC channel; this stops one that did not.
    for (const pid of builders) await stopIfCodegraph(pid);
  }, 120_000);

  // G1: each routed command runs as its builder job, the CLI process holds no lock, and the write is real.
  it('G1 init: a routed init runs as a builder init job, and no CLI process holds the root lock', async () => {
    // Can pass 5 s at load 7-11: a CLI init of a small repository whose cold index runs in the builder, a 20 ms lock
    // sampler over its lock files, and a query.
    const problems = [...builderProblems, ...serverProblems];
    const from = builderLogLines(stateDir).length;
    const sampler = startLockSampler(stateDir, [R1]);
    const run = await runCli(['init', R1], stateDir, root);
    problems.push(...exitProblems('codegraph init', run));
    problems.push(...(await jobProblems(stateDir, 'codegraph init', from, 'init', R1)));
    await sampler.stop();
    problems.push(...holderProblems('codegraph init', sampler, run.pid, true));
    problems.push(...(await findsSymbol(stateDir, root, R1, 'g1InitBase')));
    expect(problems, 'G1 init problems (empty when init ran as a builder job, the CLI held no lock, and the index answers)').toEqual([]);
  }, 300_000);

  it('G1 sync: a routed sync after an edit runs as a builder sync job, and no CLI process holds the root lock', async () => {
    // Can pass 5 s at load 7-11: an edit, a CLI sync and its builder job, a 20 ms lock sampler, and a query.
    const problems = [...builderProblems, ...serverProblems];
    appendFn(R2, 'src/two.ts', 'g1SyncSymbol');
    const from = builderLogLines(stateDir).length;
    const sampler = startLockSampler(stateDir, [R2]);
    const run = await runCli(['sync', R2], stateDir, root);
    problems.push(...exitProblems('codegraph sync', run));
    problems.push(...(await jobProblems(stateDir, 'codegraph sync', from, 'sync', R2)));
    await sampler.stop();
    problems.push(...holderProblems('codegraph sync', sampler, run.pid, false));
    problems.push(...(await findsSymbol(stateDir, root, R2, 'g1SyncSymbol')));
    expect(problems, 'G1 sync problems (empty when sync ran as a builder sync job, the CLI held no lock, and the edit is in the index)').toEqual([]);
  }, 300_000);

  it('G1 index: a routed index runs as a builder index job under the lease, and no CLI process holds the root lock', async () => {
    // Can pass 5 s at load 7-11: an edit, a CLI index (a full rebuild, under the builder's lease), a 20 ms lock sampler,
    // and a query.
    const problems = [...builderProblems, ...serverProblems];
    appendFn(R3, 'src/three.ts', 'g1IndexSymbol');
    const from = builderLogLines(stateDir).length;
    const sampler = startLockSampler(stateDir, [R3]);
    const run = await runCli(['index', R3], stateDir, root);
    problems.push(...exitProblems('codegraph index', run));
    problems.push(...(await jobProblems(stateDir, 'codegraph index', from, 'index', R3)));
    await sampler.stop();
    problems.push(...holderProblems('codegraph index', sampler, run.pid, true));
    problems.push(...(await findsSymbol(stateDir, root, R3, 'g1IndexSymbol')));
    expect(problems, 'G1 index problems (empty when index ran as a builder index job, the CLI held no lock, and the rebuilt index answers)').toEqual([]);
  }, 300_000);

  it('G1 checkpoint --fresh: a routed --fresh wait runs as a builder sync job, prints fresh=yes, and no CLI process holds the lock', async () => {
    // Can pass 5 s at load 7-11: an edit, a checkpoint whose --fresh wait is a builder sync job, a 20 ms lock sampler,
    // and a query.
    const problems = [...builderProblems, ...serverProblems];
    appendFn(R6, 'src/six.ts', 'g1FreshSymbol');
    const from = builderLogLines(stateDir).length;
    const sampler = startLockSampler(stateDir, [R6]);
    const run = await runCli(['checkpoint', R6, '--fresh'], stateDir, root);
    problems.push(...exitProblems('codegraph checkpoint --fresh', run));
    if (!/fresh=yes/.test(run.stdout)) {
      problems.push(`codegraph checkpoint --fresh did not print fresh=yes: stdout ${JSON.stringify(tail(run.stdout))}`);
    }
    problems.push(...(await jobProblems(stateDir, 'codegraph checkpoint --fresh', from, 'sync', R6)));
    await sampler.stop();
    problems.push(...holderProblems('codegraph checkpoint --fresh', sampler, run.pid, false));
    problems.push(...(await findsSymbol(stateDir, root, R6, 'g1FreshSymbol')));
    expect(problems, 'G1 checkpoint --fresh problems (empty when the wait ran as a builder sync job, printed fresh=yes, and the edit is in the index)').toEqual([]);
  }, 300_000);

  // G3: the routed run and the in-process run of the same content print the same output, after normalising.
  it('G3 equivalence: a routed run and an in-process run of init, sync, index and checkpoint --fresh print the same output', async () => {
    // Over 5 s by design: eight CLI runs (four routed under the running server, four in-process on the twin repository
    // with an empty state dir), with the routed runs waited on for their builder jobs, on a machine at load 7-11.
    const problems = [...builderProblems, ...serverProblems];
    const steps: Array<{ label: string; args: (repo: string) => string[]; edit?: string; kind: string }> = [
      { label: 'init', args: (repo) => ['init', repo], kind: 'init' },
      { label: 'sync', args: (repo) => ['sync', repo], edit: 'g3First', kind: 'sync' },
      { label: 'index', args: (repo) => ['index', repo], kind: 'index' },
      { label: 'checkpoint --fresh', args: (repo) => ['checkpoint', repo, '--fresh'], edit: 'g3Second', kind: 'sync' },
    ];
    for (const step of steps) {
      if (step.edit !== undefined) {
        appendFn(TA, 'src/twin.ts', step.edit);
        appendFn(TB, 'src/twin.ts', step.edit);
      }
      const from = builderLogLines(stateDir).length;
      const routed = await runCli(step.args(TA), stateDir, root);
      const inProcess = await runCli(step.args(TB), stateB, root);
      problems.push(...exitProblems(`routed ${step.label}`, routed));
      problems.push(...exitProblems(`in-process ${step.label}`, inProcess));
      problems.push(...(await jobProblems(stateDir, `routed ${step.label}`, from, step.kind, TA)));
      if (routed.status !== inProcess.status) {
        problems.push(`${step.label}: exit codes differ: routed ${String(routed.status)}, in-process ${String(inProcess.status)}`);
      }
      const routedOut = normalise(routed.stdout, TA);
      const inProcessOut = normalise(inProcess.stdout, TB);
      if (routedOut !== inProcessOut) {
        problems.push(
          `${step.label}: stdout differs after normalising.\n--- routed:\n${routedOut}\n--- in-process:\n${inProcessOut}\n---`,
        );
      }
      const routedErr = normalise(routed.stderr, TA);
      const inProcessErr = normalise(inProcess.stderr, TB);
      if (routedErr !== inProcessErr) {
        problems.push(
          `${step.label}: stderr differs after normalising.\n--- routed:\n${routedErr}\n--- in-process:\n${inProcessErr}\n---`,
        );
      }
    }
    expect(problems, 'G3 problems (empty when each routed run is a builder job and prints what its in-process twin prints, with the same exit code)').toEqual([]);
  }, 600_000);

  // G4: a refusal. Each request is answered with a JSON-RPC error and writes nothing.
  /**
   * Opens a raw connection with `clientHello` (null: none), sends one codegraph/indexWrite `init` for `repo`, and
   * returns what is wrong with the answer: no JSON-RPC error with the refusal's code (-32600, InvalidRequest), or a
   * `.codegraph` written in `repo`. A MethodNotFound (-32601) answer means the method is not there at all, not that it refused.
   */
  async function refusalProblems(
    label: string,
    repo: string,
    clientHello: Record<string, unknown> | null,
  ): Promise<string[]> {
    const socketPath = socketPathOf(stateDir);
    if (socketPath === null) return [`${label}: ${path.join(stateDir, 'server.pid')} names no socket`];
    const problems: string[] = [];
    let peer: RawPeer | undefined;
    let reply: RpcMessage | undefined;
    try {
      peer = await openRaw(socketPath, clientHello);
      peer.send({ jsonrpc: '2.0', id: 1, method: 'codegraph/indexWrite', params: { op: 'init', root: repo } });
      reply = await peer.reply(1, 30_000);
    } catch (err) {
      problems.push(`${label}: no reply to codegraph/indexWrite: ${String(err)}`);
    } finally {
      peer?.destroy();
    }
    if (reply !== undefined && reply.error === undefined) {
      problems.push(`${label}: the reply is a result, not a JSON-RPC error: ${JSON.stringify(reply).slice(0, 300)}`);
    } else if (reply !== undefined) {
      const code = (reply.error as { code?: unknown }).code;
      if (code !== REFUSED_CODE) {
        problems.push(
          `${label}: the JSON-RPC error code is ${String(code)}, not ${REFUSED_CODE} (InvalidRequest, the refusal): ` +
            JSON.stringify(reply.error).slice(0, 300),
        );
      }
    }
    if (fs.existsSync(path.join(repo, '.codegraph'))) {
      problems.push(`${label}: ${path.join(repo, '.codegraph')} was created by a refused request`);
    }
    return problems;
  }

  // Fails on a tree without the route: the method is absent there, so the reply is MethodNotFound (-32601), not the
  // refusal (-32600). The gate asserts the refusal itself: a session (a client hello with launchDir) is not the CLI.
  it('G4a refusal: a session hello with launchDir gets a JSON-RPC error for codegraph/indexWrite, and the root gets no .codegraph', async () => {
    const launchDir = fx.tempRoot();
    const problems = [
      ...serverProblems,
      ...(await refusalProblems('session (client hello with launchDir)', R4a, {
        codegraph_client: 1,
        control: 1,
        pid: process.pid,
        hostPid: null,
        launchDir,
      })),
    ];
    expect(problems, 'G4a problems (empty when the session is refused with a JSON-RPC error and nothing is written)').toEqual([]);
  }, 120_000);

  // Fails on a tree without the route, for the same reason as G4a. The gate asserts the refusal for the legacy client: no hello at all.
  it('G4b refusal: a connection with no client hello gets a JSON-RPC error for codegraph/indexWrite, and the root gets no .codegraph', async () => {
    const problems = [
      ...serverProblems,
      ...(await refusalProblems('legacy connection (no client hello)', R4b, null)),
    ];
    expect(problems, 'G4b problems (empty when the legacy connection is refused with a JSON-RPC error and nothing is written)').toEqual([]);
  }, 120_000);

  // The control role is granted on the `control: 1` marker, not on a missing launchDir: a client hello with neither the
  // marker nor a launchDir (what any client of the socket can send, and what a session without an anchor looks like) is refused.
  it('G4c refusal: a client hello with no launchDir and no control marker gets a JSON-RPC error for codegraph/indexWrite, and the root gets no .codegraph', async () => {
    const problems = [
      ...serverProblems,
      ...(await refusalProblems('client hello without the control marker and without launchDir', fx.makeRepo(path.join(root, 'r4c'), { 'src/four.ts': fn('g4cBase') }), {
        codegraph_client: 1,
        pid: process.pid,
        hostPid: null,
      })),
    ];
    expect(problems, 'G4c problems (empty when the unmarked hello is refused with a JSON-RPC error and nothing is written)').toEqual([]);
  }, 120_000);

  // G5: an index lease belongs to its connection. It is held while the connection is open, and released when it goes.
  it('G5 lease: an index lease is held while its control connection is open, and released when the connection goes', async () => {
    // Can pass 5 s at load 7-11: a routed index of a small repository under the builder's locks, a bounded wait for the
    // lease to go, and a CLI sync.
    const problems = [...builderProblems, ...serverProblems];
    const socketPath = socketPathOf(stateDir);
    if (socketPath !== null) {
      let peer: RawPeer | undefined;
      let leaseTaken = false;
      try {
        peer = await openRaw(socketPath, { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null });
        peer.send({ jsonrpc: '2.0', id: 1, method: 'codegraph/indexWrite', params: { op: 'index', root: R5 } });
        const reply = await peer.reply(1, REPLY_MS);
        if (reply.error !== undefined) {
          problems.push(`the index request was answered with a JSON-RPC error, not a result: ${JSON.stringify(reply.error).slice(0, 300)}`);
        } else if (!isRouted(reply.result)) {
          problems.push(`the index request was not routed: ${JSON.stringify(reply.result).slice(0, 300)}`);
        } else {
          leaseTaken = true;
          // The reply is sent once the index is written; the lease (rebuild.pid, writer.pid) stays with this connection.
          const builder = builderPidOf(stateDir);
          for (const file of ['rebuild.pid', 'writer.pid']) {
            const holder = lockFileHolders(R5).find((h) => h.file === file);
            if (holder === undefined) {
              problems.push(`after the index reply, with its connection open, ${file} under ${R5} is absent: the lease is not held`);
            } else if (holder.pid !== builder) {
              problems.push(`${file} under ${R5} names pid ${holder.pid}, not the builder's pid ${String(builder)}`);
            }
          }
        }
      } catch (err) {
        problems.push(`the index connection failed: ${String(err)}`);
      } finally {
        // Closed without codegraph/indexWriteEnd: the server must release the lease when the connection goes.
        peer?.destroy();
      }
      if (leaseTaken) {
        const released = await waitUntil(() => leaseHolders(R5).length === 0, LEASE_RELEASE_MS, 100);
        if (!released) {
          problems.push(
            `the index lease was not released within ${LEASE_RELEASE_MS / 1000} s of the connection closing: ` +
              JSON.stringify(leaseHolders(R5)),
          );
        }
      }
    }
    const sync = await runCli(['sync', R5], stateDir, root);
    problems.push(...exitProblems('codegraph sync after the lease', sync));
    expect(problems, 'G5 problems (empty when the lease is held while the connection is open, released when it goes, and a sync then succeeds)').toEqual([]);
  }, 300_000);

  /**
   * The engine's verbose diagnostics and the verbose progress lines of a run, in stdout order: the lines
   * `[worker] ...` and `[wal-valve] ...` the engine prints for indexAll({verbose: true}), and the
   * `[<time>] Phase: ...` lines createVerboseProgress prints, after normalising durations and the repository path.
   */
  function verboseLines(stdout: string, repo: string): string[] {
    return normalise(stdout, repo)
      .split('\n')
      .filter((line) => /^\[(worker|wal-valve)\] /.test(line) || /^\[[^\]]*\] Phase: /.test(line));
  }

  // G6: --verbose keeps the engine's diagnostics when the write runs in the builder. The comparison is the strictest
  // that is stable: the whole sequence of those lines, equal line for line, because the builder's lines for a small
  // repository carry no timing or count that differs from the CLI's own (the worker pool size is the same machine's).
  it('G6 verbose: a routed init --verbose and index --verbose print the same [worker] and Phase lines as in-process', async () => {
    // Over 5 s by design: four CLI runs (a routed and an in-process init, and the same for index) of small
    // repositories, with the routed ones waited on for their builder jobs, on a machine at load 7-11.
    const problems = [...builderProblems, ...serverProblems];
    const files = { 'src/v.ts': fn('g6Verbose'), 'src/w.ts': fn('g6Other') };
    const initA = fx.makeRepo(path.join(root, 'v6-init-a'), files);
    const initB = fx.makeRepo(path.join(root, 'v6-init-b'), files);
    const indexA = fx.makeRepo(path.join(root, 'v6-index-a'), files);
    const indexB = fx.makeRepo(path.join(root, 'v6-index-b'), files);
    // The index twins are indexed beforehand under the state dir with no server (stateB), so `index` finds them initialized.
    fx.index(indexA, stateB);
    fx.index(indexB, stateB);

    const steps = [
      { label: 'init --verbose', kind: 'init', routedRepo: initA, plainRepo: initB, args: (repo: string) => ['init', '--verbose', repo] },
      { label: 'index --verbose', kind: 'index', routedRepo: indexA, plainRepo: indexB, args: (repo: string) => ['index', '--verbose', repo] },
    ];
    for (const step of steps) {
      const from = builderLogLines(stateDir).length;
      const routed = await runCli(step.args(step.routedRepo), stateDir, root);
      const inProcess = await runCli(step.args(step.plainRepo), stateB, root);
      problems.push(...exitProblems(`routed ${step.label}`, routed));
      problems.push(...exitProblems(`in-process ${step.label}`, inProcess));
      problems.push(...(await jobProblems(stateDir, `routed ${step.label}`, from, step.kind, step.routedRepo)));
      const routedLines = verboseLines(routed.stdout, step.routedRepo);
      const plainLines = verboseLines(inProcess.stdout, step.plainRepo);
      if (!plainLines.some((line) => line.startsWith('[worker] '))) {
        problems.push(`${step.label}: the in-process run printed no [worker] line, so the comparison proves nothing: ${JSON.stringify(tail(inProcess.stdout))}`);
      }
      if (!routedLines.some((line) => line.startsWith('[worker] '))) {
        problems.push(`${step.label}: the routed run printed no [worker] line (the engine's verbose output was lost)`);
      }
      if (JSON.stringify(routedLines) !== JSON.stringify(plainLines)) {
        problems.push(
          `${step.label}: the [worker] / [wal-valve] / Phase lines differ.\n--- routed:\n${routedLines.join('\n')}\n--- in-process:\n${plainLines.join('\n')}\n---`,
        );
      }
    }
    expect(problems, 'G6 problems (empty when each routed --verbose run is a builder job and prints the in-process run\'s engine and phase lines in order)').toEqual([]);
  }, 600_000);
});

describe('CLI index writes with no server running (G2)', () => {
  const fx = new Fixtures();
  const stateDirs: string[] = [];

  afterAll(async () => {
    const builders = stateDirs.map((dir) => builderPidOf(dir)).filter((pid): pid is number => pid !== null);
    stateDirs.length = 0;
    await fx.teardown();
    for (const pid of builders) await stopIfCodegraph(pid);
  }, 120_000);

  // G2 describes the in-process path: the CLI's writes when no server (and so no builder) runs for the state dir. The
  // stale builder.pid part checks that a dead builder record alone does not route the CLI, and that the CLI leaves it as it is.
  it('G2 none running: the four commands succeed in-process, leave no server.pid or builder.pid, and ignore a stale builder.pid', async () => {
    // Over 5 s by design: three in-process index builds of small repositories, four CLI writes and their queries, and a
    // second sync, on a machine at load 7-11.
    const dir = fx.tempRoot();
    const state = path.join(dir, 'state');
    stateDirs.push(state);
    const n1 = fx.makeRepo(path.join(dir, 'n1'), { 'src/one.ts': fn('g2InitBase') });
    const n2 = fx.makeRepo(path.join(dir, 'n2'), { 'src/two.ts': fn('g2SyncBase') });
    const n3 = fx.makeRepo(path.join(dir, 'n3'), { 'src/three.ts': fn('g2IndexBase') });
    fx.index(n2, state);
    fx.index(n3, state);
    const problems: string[] = [];

    const init = await runCli(['init', n1], state, dir);
    problems.push(...exitProblems('codegraph init', init));
    problems.push(...(await findsSymbol(state, dir, n1, 'g2InitBase')));

    appendFn(n2, 'src/two.ts', 'g2SyncSymbol');
    const sync = await runCli(['sync', n2], state, dir);
    problems.push(...exitProblems('codegraph sync', sync));
    problems.push(...(await findsSymbol(state, dir, n2, 'g2SyncSymbol')));

    appendFn(n3, 'src/three.ts', 'g2IndexSymbol');
    const index = await runCli(['index', n3], state, dir);
    problems.push(...exitProblems('codegraph index', index));
    problems.push(...(await findsSymbol(state, dir, n3, 'g2IndexSymbol')));

    appendFn(n2, 'src/two.ts', 'g2FreshSymbol');
    const fresh = await runCli(['checkpoint', n2, '--fresh'], state, dir);
    problems.push(...exitProblems('codegraph checkpoint --fresh', fresh));
    if (!/fresh=yes/.test(fresh.stdout)) {
      problems.push(`codegraph checkpoint --fresh did not print fresh=yes: stdout ${JSON.stringify(tail(fresh.stdout))}`);
    }
    problems.push(...(await findsSymbol(state, dir, n2, 'g2FreshSymbol')));

    for (const file of ['server.pid', 'builder.pid']) {
      if (fs.existsSync(path.join(state, file))) problems.push(`${file} exists in the state dir after the four in-process commands`);
    }

    // A builder.pid that names a dead process, as a crashed builder leaves it. Nothing above has created the state dir,
    // so the gate creates it to hold the record.
    const dead = await deadPid();
    if (isAlive(dead)) problems.push(`could not get a dead pid for the stale record: ${dead} is still alive`);
    fs.mkdirSync(state, { recursive: true });
    const stalePath = path.join(state, 'builder.pid');
    const staleText = JSON.stringify({ pid: dead, serverPid: dead, startedAt: new Date().toISOString() });
    fs.writeFileSync(stalePath, staleText);
    appendFn(n2, 'src/two.ts', 'g2StaleSymbol');
    const stale = await runCli(['sync', n2], state, dir);
    problems.push(...exitProblems('codegraph sync with a stale builder.pid', stale));
    problems.push(...(await findsSymbol(state, dir, n2, 'g2StaleSymbol')));
    if (fs.existsSync(path.join(state, 'server.pid'))) {
      problems.push('a server.pid appeared after the sync with a stale builder.pid');
    }
    const afterText = fs.existsSync(stalePath) ? fs.readFileSync(stalePath, 'utf8') : '<absent>';
    if (afterText !== staleText) {
      problems.push(`the stale builder.pid was changed by the CLI: it was ${staleText}, now ${afterText}`);
    }
    if (builderLogLines(state).length > 0) {
      problems.push(`builder.log has lines in a state dir with no server: a builder ran (${builderLogLines(state)[0]})`);
    }

    expect(problems, 'G2 problems (empty when the four commands run in-process, write no pid files, and ignore a stale builder.pid)').toEqual([]);
  }, 300_000);
});
