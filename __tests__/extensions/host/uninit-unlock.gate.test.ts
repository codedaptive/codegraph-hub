/**
 * The uninit and unlock gates: `codegraph uninit` releases the project's index in the machine server before it
 * deletes the index, and `codegraph unlock` takes a lock out only when its holder is not running.
 *
 *   UG1   uninit --force under a running server and builder: the index is deleted, and neither process holds a file
 *         under the project's `.codegraph` afterwards (lsof).
 *   UG1b  ordering: the server is asked to release the index while `.codegraph` still exists, and the lease ends after
 *         it is gone. A stand-in server speaks the wire the CLI uses and records each request.
 *   UG2   uninit --force with no server: the index is deleted, exit 0, the success line, and no server.pid or builder.pid.
 *   UG3   the uninit under a running server prints what the in-process uninit of the same index prints.
 *   UL1   unlock with a lock held by a live pid: exit 1, a message naming the pid, and the lock file unchanged.
 *   UL2   unlock with a lock whose pid has exited, and with a lock whose first line is not a pid: the lock is taken,
 *         exit 0, and the success line.
 *   UL3   unlock with the lock a symlink to a dead owner's file: the link is removed, the file it points to is kept, exit 0.
 *   UL4   unlock with the lock a symlink to a live owner's file: exit 1, and the link and the file are untouched.
 *   UL5   unlock with a directory at the lock: exit 1, and the directory and what is in it are kept.
 *   UL6   unlock with a first line of 0 or -1 (no process): the lock is taken, exit 0, and the success line.
 *   UL7   unlock with a first line of 1: pid 1 runs and is not this user's to signal, so it holds: exit 1, lock kept.
 *   UL8   unlock with a live pid whose owner record names another project and index: the lock is taken, exit 0.
 *   RF1-RF4  a release request to the running server's control socket: a relative root, a regular file, and an
 *         uninitialized directory are refused with InvalidParams (-32602) and create nothing; a hello without the
 *         control marker is refused with InvalidRequest (-32600) and the indexed root keeps its index.
 *
 * Each gate drives the built CLI (dist/bin/codegraph.js, built by the suite's global setup) as a child process,
 * non-TTY, with CODEGRAPH_STATE_DIR set. The projects are plain directories: a git worktree is re-seeded from another
 * worktree of its repository. The gates that read a process's open files with lsof are skipped where lsof is absent.
 * The helpers that start a server and read pid files are in machine-server.harness.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { getCodeGraphDir } from '../../../src/directory';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { INDEX_WRITE_END_METHOD, INDEX_WRITE_METHOD } from '../../../src/extensions/host/builder/cli-wire';
import { getStateDir, getStateDirIdentity } from '../../../src/extensions/host/server/state-dir';
import { processStartTime } from '../../../src/mcp/process-identity';
import { isForeignLockRecord, lockStamp } from '../../../src/mcp/writer-lock';
import {
  BIN,
  Fixtures,
  LSOF_AVAILABLE,
  McpSession,
  builderPidOf,
  gateEnv,
  isAlive,
  serverPidOf,
  stopIfCodegraph,
  waitUntil,
} from './machine-server.harness';

/** How long a server may take to write builder.pid after its start. A cold start at load 45 is slow. */
const BUILDER_APPEAR_MS = 60_000;
/** The bound on one CLI run: a run that never ends fails here instead of hanging the file. */
const CLI_RUN_MS = 240_000;
/** The period of the lsof poll. lsof is a subprocess, so the poll does not run at the 25 ms default. */
const LSOF_POLL_MS = 500;
/** The explore tool's name, as the server lists it. Its answer is not judged here: the call opens the index in the server. */
const EXPLORE = 'codegraph_explore';
/**
 * The version the stand-in server reports in its hello and in server.pid. Any string serves: the CLI compares the
 * hello's version only with the one in server.pid.
 */
const STAND_IN_VERSION = 'uninit-unlock-gate-stand-in';

/** Strips ANSI escapes and carriage returns, so a line is compared as the terminal shows it. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
function plain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE, '');
}

/** The output with the project's path replaced by <ROOT>, so two runs on two projects compare equal. */
function normalise(text: string, root: string): string {
  return plain(text).split(root).join('<ROOT>');
}

/** The last 400 characters of a text, for a failure message. */
function tail(text: string): string {
  const t = text.trim();
  return t.length > 400 ? `...${t.slice(-400)}` : t;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a success() line: the success glyph and one space, then the message, and nothing else. success() prints the
 * Unicode glyph where the terminal supports it and the ASCII one elsewhere, so both are accepted.
 */
function successLine(message: string): RegExp {
  return new RegExp(`^(?:✓|\\[OK\\]) ${escapeRegExp(message)}$`);
}

/** A one-function TypeScript file in `dir/src`, committed to nothing: a plain directory, indexed by the caller. */
function plainProject(dir: string, symbol: string): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export function ${symbol}(): number {\n  return 1;\n}\n`);
  return fs.realpathSync(dir);
}

/** One CLI run: its exit status, its whole stdout and stderr, and the pid of the process. */
interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
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
 * The open files of `pid` under `dir`, as lsof names them with -Fn. A file the process holds after it was deleted
 * keeps its path here with no mark, so a handle to a deleted index is listed.
 *
 * lsof's exit status says whether an empty list is an answer or a failed inspection. Exit 0: the names are the answer,
 * whatever lsof wrote to stderr (it warns about entries it cannot read and still lists the rest). Exit 1 with empty
 * stdout and empty stderr for a pid that is running: lsof matched no file for the selection, and that is the answer,
 * an empty list (macOS exits 1 this way when nothing matches). Every other outcome throws, so a failed inspection
 * fails the test rather than reading as "no holder": lsof did not run, was killed by the timeout, exited non-zero
 * in any other way (any other status, or status 1 with stdout or stderr output), or was asked about a pid that is not
 * running (lsof names nothing for one, and the caller asked about a process that is there to hold files).
 */
function openUnder(pid: number, dir: string): string[] {
  const res = spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 60_000 });
  if (res.error) throw new Error(`lsof -p ${pid} did not run: ${res.error.message}`);
  if (res.signal !== null) throw new Error(`lsof -p ${pid} was ended by ${res.signal} before it answered`);
  const stdout = res.stdout ?? '';
  const stderr = (res.stderr ?? '').trim();
  if (res.status !== 0) {
    const running = isAlive(pid);
    const noMatch = res.status === 1 && stdout.trim() === '' && stderr === '' && running;
    if (!noMatch) {
      const why = stderr === '' ? '(no stderr)' : JSON.stringify(tail(stderr));
      throw new Error(`lsof -p ${pid} exited ${String(res.status)} ${why}; the pid is ${running ? 'running' : 'not running'}`);
    }
    return [];
  }
  const names = stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  return names.filter((name) => name === dir || name.startsWith(dir + path.sep));
}

/** The pids of `pids` (nulls skipped) that hold a codegraph.db under `dir` open. */
function dbHolders(pids: Array<number | null>, dir: string): number[] {
  return pids.filter(
    (pid): pid is number => pid !== null && openUnder(pid, dir).some((name) => path.basename(name) === 'codegraph.db'),
  );
}

/** Whether `candidate` names the directory `dir`, by its path or by its real path. */
function sameDir(candidate: string | null, dir: string): boolean {
  if (candidate === null) return false;
  if (candidate === dir) return true;
  try {
    return fs.realpathSync(candidate) === dir;
  } catch {
    return false;
  }
}

/**
 * The stamp FileLock writes for a holder at `root`, built as lockStamp builds it: this root's canonical path and
 * index identity, the holder's pid, and its OS start time when one reads. lockStamp reads the calling process's own
 * pid and start time, so the holder's take their place here. The stamp's root and identity match this root, so
 * isForeignLockRecord decides it by the holder's liveness alone.
 */
function stampFor(root: string, pid: number): Record<string, unknown> {
  const own = lockStamp(root);
  const start = processStartTime(pid);
  return {
    root: own.root,
    ...(own.dirId !== undefined && own.dbId !== undefined ? { dirId: own.dirId, dbId: own.dbId } : {}),
    pid,
    ...(start !== null ? { pidStart: start } : {}),
  };
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

/**
 * The state dir's canonical path and identity as the CLI computes them from CODEGRAPH_STATE_DIR. The helpers read the
 * variable when called, so it is set for the call and restored after it.
 */
function stateIdentity(stateDir: string): { stateDir: string; stateId: string } {
  const saved = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = stateDir;
  try {
    return { stateDir: getStateDir(), stateId: getStateDirIdentity() ?? '' };
  } finally {
    if (saved === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = saved;
  }
}

/** One request a stand-in received: its method, its op and root (when it carries them), and whether the root's `.codegraph` existed on arrival. */
interface StandInRequest {
  method: string;
  op: string | null;
  root: string | null;
  rootIndexExisted: boolean | null;
}

interface StandIn {
  /** Every request that arrived, in arrival order. */
  requests: StandInRequest[];
  stop: () => Promise<void>;
}

/** What the stand-in answers to each request the CLI's index writes and releases make. */
function answerTo(method: string, op: string | null): unknown {
  if (method === INDEX_WRITE_METHOD) {
    return op === 'release'
      ? { routed: true, result: { released: true } }
      : { routed: false, reason: 'the stand-in answers only the release request' };
  }
  if (method === INDEX_WRITE_END_METHOD) return { ended: true };
  if (method === 'codegraph/releaseProject') return { released: true };
  return {};
}

/**
 * A stand-in machine server for `stateDir`. It listens on a socket, answers the server hello the CLI's probe reads, and
 * answers the CLI's requests as {@link answerTo} gives. It writes `<state>/server.pid` naming this test process (alive),
 * the socket, and the state dir's identity, so the CLI's probe takes it for the running server. Each request is recorded
 * with whether `<root>/.codegraph` existed when it arrived.
 */
async function startStandIn(stateDir: string): Promise<StandIn> {
  const identity = stateIdentity(stateDir);
  if (identity.stateId === '') throw new Error(`${stateDir} has no identity: it does not exist`);
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgus-'));
  const socketPath = path.join(socketDir, 's.sock');
  const requests: StandInRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.write(JSON.stringify({ protocol: 1, codegraph: STAND_IN_VERSION, pid: process.pid }) + '\n');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === '') continue;
        let msg: { id?: unknown; method?: unknown; params?: { op?: unknown; root?: unknown } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        // The CLI's client hello carries no method: it is not a request.
        if (typeof msg.method !== 'string') continue;
        const root = typeof msg.params?.root === 'string' ? msg.params.root : null;
        const op = typeof msg.params?.op === 'string' ? msg.params.op : null;
        requests.push({
          method: msg.method,
          op,
          root,
          rootIndexExisted: root === null ? null : fs.existsSync(getCodeGraphDir(root)),
        });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answerTo(msg.method, op) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.writeFileSync(
    path.join(stateDir, 'server.pid'),
    JSON.stringify(
      {
        pid: process.pid,
        version: STAND_IN_VERSION,
        socketPath,
        startedAt: Date.now(),
        stateDir: identity.stateDir,
        stateId: identity.stateId,
      },
      null,
      2,
    ) + '\n',
  );
  return {
    requests,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(socketDir, { recursive: true, force: true });
    },
  };
}

/** One line per request, for a failure message. */
function describeRequests(requests: StandInRequest[]): string {
  if (requests.length === 0) return 'none';
  return requests
    .map((r) => `${r.method}${r.op !== null ? ` op=${r.op}` : ''}${r.root !== null ? ` root=${r.root}` : ''}`)
    .join('; ');
}

/** The InvalidRequest code: what the server answers a client hello without the control marker (cli-relay.ts). */
const REFUSED_CODE = -32600;
/** The InvalidParams code: what the server answers a release whose root is relative, a file, or uninitialized. */
const INVALID_PARAMS_CODE = -32602;
/** How long a raw reply may take. A refusal is answered at once, so this only bounds a hang. */
const REPLY_MS = 30_000;

/** The client hello the CLI sends: the control marker and no launchDir (server-control.ts controlClientHelloLine). */
function controlHello(): Record<string, unknown> {
  return { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null };
}

/** A JSON-RPC message the server sent: a reply by id, with a result or an error. */
interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

/** One raw control connection: send a request, read its reply by id, close it. */
interface RawPeer {
  send: (msg: unknown) => void;
  reply: (id: number, timeoutMs: number) => Promise<RpcMessage>;
  destroy: () => void;
}

/** The socket path the server's server.pid names, or null when the record is absent or unreadable. */
function socketPathOf(stateDir: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8')) as { socketPath?: unknown };
    return typeof record.socketPath === 'string' && record.socketPath !== '' ? record.socketPath : null;
  } catch {
    return null;
  }
}

/**
 * Opens a raw connection to the server's socket: reads the server hello, sends `clientHello` as the client hello when
 * it is given (none when null: a legacy client), and resolves once the hello is through. Requests go out with `send`;
 * replies are read with `reply`, by id.
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

/** One refused release request: the answer it must get, and what must (or must not) exist on disk after it. */
interface RefusalCase {
  label: string;
  root: string;
  /** The client hello to send first; null sends none. */
  clientHello: Record<string, unknown> | null;
  /** The JSON-RPC error code the answer must carry. */
  code: number;
  /** The error message must match this; null does not check it. */
  message: RegExp | null;
  /** Paths that must not exist after the request: a fence or an index it created is a failure. */
  absent: string[];
  /** Paths that must still exist after the request. */
  present: string[];
}

/**
 * What a path is, without following a link: `missing`, `file`, `directory`, `symlink`, or `other`. A link is reported
 * as a link even when its target is a file or a directory, so a case can tell the link from what it points to.
 */
function entryKind(p: string): 'missing' | 'file' | 'directory' | 'symlink' | 'other' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/** A file's text, or null when it is absent or is not a readable file (a link to nothing, a directory). */
function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

describe('uninit with a machine server running (UG1, UG3, RF1-RF4)', () => {
  const fx = new Fixtures();
  /** The directory every CLI run is started in. */
  let launchDir = '';
  /** The state dir the server runs in. */
  let stateDir = '';
  /** The state dir of the in-process twin (UG3): no server runs in it. */
  let stateB = '';
  /** The project UG1 deletes under the running server. */
  let U1 = '';
  /** The project UG3 deletes under the running server. */
  let U3r = '';
  /** The project UG3 deletes with no server: the in-process twin of U3r. */
  let U3p = '';
  /** An indexed project no case deletes: the release refusal (RF4) must leave its index in place. */
  let U4 = '';
  let session: McpSession | undefined;
  /** Set in beforeAll when the setup did not reach a running builder or server; every gate reports it. */
  let builderProblems: string[] = [];
  let serverProblems: string[] = [];

  /** A serve --mcp session with CODEGRAPH_AUTO_INDEX unset: the spawn copies the environment, so it is restored at once. */
  function startSession(cwd: string, state: string): McpSession {
    const saved = process.env.CODEGRAPH_AUTO_INDEX;
    delete process.env.CODEGRAPH_AUTO_INDEX;
    try {
      return fx.session({ cwd, stateDir: state });
    } finally {
      if (saved !== undefined) process.env.CODEGRAPH_AUTO_INDEX = saved;
    }
  }

  /**
   * Sends one codegraph/indexWrite `release` for `c.root` over a raw connection to the running server, and returns what
   * is wrong with the answer: no JSON-RPC error, an error with another code or message, or a path that is in the wrong
   * state afterwards (`absent` exists, `present` is gone). A release that succeeds here would fence a root the caller
   * had no right to fence.
   */
  async function releaseRefusalProblems(c: RefusalCase): Promise<string[]> {
    const socketPath = socketPathOf(stateDir);
    if (socketPath === null) return [`${c.label}: ${path.join(stateDir, 'server.pid')} names no socket`];
    const problems: string[] = [];
    let peer: RawPeer | undefined;
    let reply: RpcMessage | undefined;
    try {
      peer = await openRaw(socketPath, c.clientHello);
      peer.send({ jsonrpc: '2.0', id: 1, method: 'codegraph/indexWrite', params: { op: 'release', root: c.root } });
      reply = await peer.reply(1, REPLY_MS);
    } catch (err) {
      problems.push(`${c.label}: no reply to codegraph/indexWrite: ${String(err)}`);
    } finally {
      peer?.destroy();
    }
    if (reply !== undefined) {
      if (reply.error === undefined) {
        problems.push(`${c.label}: the reply is a result, not a JSON-RPC error: ${JSON.stringify(reply).slice(0, 300)}`);
      } else {
        const err = reply.error as { code?: unknown; message?: unknown };
        if (err.code !== c.code) {
          problems.push(
            `${c.label}: the JSON-RPC error code is ${String(err.code)}, not ${c.code}: ${JSON.stringify(reply.error).slice(0, 300)}`,
          );
        }
        if (c.message !== null && !c.message.test(String(err.message))) {
          problems.push(`${c.label}: the error message ${JSON.stringify(String(err.message))} does not match ${String(c.message)}`);
        }
      }
    }
    for (const p of c.absent) {
      if (fs.existsSync(p)) problems.push(`${c.label}: ${p} exists after the refused request`);
    }
    for (const p of c.present) {
      if (!fs.existsSync(p)) problems.push(`${c.label}: ${p} is gone after the refused request`);
    }
    return problems;
  }

  // Setup for UG1 and UG3, not a gate: three small indexes built in-process before any server exists, then a serve --mcp
  // session whose builder and server are waited on.
  beforeAll(async () => {
    const dir = fx.tempRoot();
    // A session launched outside git answers only for its launch directory and what is below it, so the session starts
    // in the directory that holds the three projects, and every project below is in its scope.
    launchDir = dir;
    stateDir = path.join(dir, 'state');
    stateB = path.join(dir, 'state-b');
    U1 = plainProject(path.join(dir, 'u1'), 'ug1Base');
    U3r = plainProject(path.join(dir, 'u3-routed'), 'ug3Routed');
    U3p = plainProject(path.join(dir, 'u3-plain'), 'ug3Routed');
    fx.index(U1, stateDir);
    fx.index(U3r, stateDir);
    fx.index(U3p, stateB);
    U4 = plainProject(path.join(dir, 'u4-refused'), 'rf4Base');
    fx.index(U4, stateDir);

    session = startSession(launchDir, stateDir);
    await session.initialize();
    const builderUp = await waitUntil(() => builderPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!builderUp) {
      builderProblems = [
        `no builder.pid within ${BUILDER_APPEAR_MS / 1000} s of the server start: no builder runs for the state dir`,
      ];
    }
    const serverUp = await waitUntil(() => serverPidOf(stateDir) !== null, BUILDER_APPEAR_MS);
    if (!serverUp) serverProblems = [`no server.pid naming a server pid in ${stateDir}`];
  }, 600_000);

  afterAll(async () => {
    const builder = stateDir === '' ? null : builderPidOf(stateDir);
    await fx.teardown();
    // A builder whose server is gone exits with its IPC channel; this stops one that did not.
    if (builder !== null) await stopIfCodegraph(builder);
  }, 120_000);

  // UG1: the deletion releases the index in the server and the builder, so neither holds a file under it afterwards.
  it.runIf(LSOF_AVAILABLE)(
    'UG1 routed: uninit --force under a running server and builder deletes the index, and neither process holds a file under it',
    async () => {
      // Over 5 s at load 45-100: an explore call that opens the index in the server, a poll of lsof until a holder shows,
      // a CLI uninit, and lsof on the server and the builder.
      const problems = [...builderProblems, ...serverProblems];
      const codegraphDir = getCodeGraphDir(U1);
      const server = serverPidOf(stateDir);
      const builder = builderPidOf(stateDir);
      if (session === undefined) {
        problems.push('no serve --mcp session was started in beforeAll');
      } else {
        const answer = await session.tool(EXPLORE, { query: 'ug1Base', projectPath: U1 }, 120_000);
        if (answer.rpcError !== null) {
          problems.push(`the explore call on ${U1} answered a JSON-RPC error: ${tail(answer.rpcError)}`);
        }
      }
      // Precondition: the server or the builder holds the index open before the uninit, so the uninit has a held index to release.
      const held = await waitUntil(() => dbHolders([server, builder], codegraphDir).length > 0, 15_000, LSOF_POLL_MS);
      if (!held) {
        problems.push(
          `precondition: after the explore call, neither the server (pid ${String(server)}) nor the builder ` +
            `(pid ${String(builder)}) holds ${path.join(codegraphDir, 'codegraph.db')} open`,
        );
      }

      const run = await runCli(['uninit', '--force', U1], stateDir, launchDir);
      problems.push(...exitProblems('codegraph uninit --force', run));
      const out = normalise(run.stdout, U1).trim();
      if (!successLine('Removed CodeGraph from <ROOT>').test(out)) {
        problems.push(`stdout is not the success line for the uninit: ${JSON.stringify(tail(out))}`);
      }
      if (fs.existsSync(codegraphDir)) problems.push(`${codegraphDir} still exists after the uninit`);

      for (const [label, pid] of [
        ['server', server],
        ['builder', builder],
      ] as const) {
        if (pid === null) {
          problems.push(`no ${label} pid on record in ${stateDir}, so its open files cannot be read`);
          continue;
        }
        if (!isAlive(pid)) {
          problems.push(`the ${label} (pid ${pid}) is not running after the uninit, so its open files cannot be read`);
          continue;
        }
        const open = openUnder(pid, codegraphDir);
        if (open.length > 0) {
          problems.push(
            `the ${label} (pid ${pid}) still holds ${open.length} file(s) under ${codegraphDir} after the uninit: ${open.join(', ')}`,
          );
        }
      }
      expect(
        problems,
        'UG1 problems (empty when uninit --force exits 0 with the success line, removes .codegraph, and neither the server nor the builder holds a file under it)',
      ).toEqual([]);
    },
    300_000,
  );

  // UG3: the same index deleted under the server and with no server prints the same output and exits the same way.
  it('UG3 output: an uninit under the running server prints what the in-process uninit prints, with the same exit status', async () => {
    // Over 5 s at load 45-100: two CLI uninit runs, one under the running server and one in-process.
    const problems = [...builderProblems, ...serverProblems];
    const underServer = await runCli(['uninit', '--force', U3r], stateDir, launchDir);
    const inProcess = await runCli(['uninit', '--force', U3p], stateB, launchDir);
    problems.push(...exitProblems('uninit under the running server', underServer));
    problems.push(...exitProblems('in-process uninit', inProcess));
    if (underServer.status !== inProcess.status) {
      problems.push(
        `exit codes differ: under the server ${String(underServer.status)}, in-process ${String(inProcess.status)}`,
      );
    }
    const serverOut = normalise(underServer.stdout, U3r);
    const plainOut = normalise(inProcess.stdout, U3p);
    if (serverOut !== plainOut) {
      problems.push(
        `stdout differs after normalising.\n--- under the server:\n${serverOut}\n--- in-process:\n${plainOut}\n---`,
      );
    }
    const serverErr = normalise(underServer.stderr, U3r);
    const plainErr = normalise(inProcess.stderr, U3p);
    if (serverErr !== plainErr) {
      problems.push(
        `stderr differs after normalising.\n--- under the server:\n${serverErr}\n--- in-process:\n${plainErr}\n---`,
      );
    }
    expect(
      problems,
      'UG3 problems (empty when the uninit under the server and the in-process uninit exit the same and print the same output)',
    ).toEqual([]);
  }, 600_000);

  // RF1: a relative root is refused before anything is fenced. Asked of the server's own working directory, a relative
  // path would name a directory the caller never meant, so the refusal is the only safe answer.
  it('RF1 release refusal: a release with a relative root gets InvalidParams (-32602) naming the absolute-path rule', async () => {
    const problems = await releaseRefusalProblems({
      label: 'release with a relative root',
      root: 'relative-uninit-root',
      clientHello: controlHello(),
      code: INVALID_PARAMS_CODE,
      message: /absolute path/,
      absent: [],
      present: [],
    });
    expect([...serverProblems, ...problems], 'RF1 problems (empty when the relative-root release is refused with -32602)').toEqual([]);
  });

  // RF2: a regular file is not a project: the release is refused, and no rebuild.pid is taken for it.
  it('RF2 release refusal: a release for a regular file gets InvalidParams (-32602), and no rebuild.pid is created', async () => {
    const file = path.join(launchDir, 'not-a-project.txt');
    fs.writeFileSync(file, 'a file, not a project\n');
    const problems = await releaseRefusalProblems({
      label: 'release for a regular file',
      root: fs.realpathSync(file),
      clientHello: controlHello(),
      code: INVALID_PARAMS_CODE,
      message: /not initialized/,
      absent: [path.join(file, '.codegraph', 'rebuild.pid'), path.join(file, '.codegraph')],
      present: [],
    });
    expect([...serverProblems, ...problems], 'RF2 problems (empty when the regular-file release is refused with -32602 and creates nothing)').toEqual([]);
  });

  // RF3: a directory with no index is refused, and the refusal creates neither .codegraph nor rebuild.pid in it.
  it('RF3 release refusal: a release for an uninitialized directory gets InvalidParams (-32602), and creates neither .codegraph nor rebuild.pid', async () => {
    const bare = path.join(launchDir, 'uninit-bare');
    fs.mkdirSync(path.join(bare, 'src'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'src', 'a.ts'), 'export function rf3Base(): number {\n  return 1;\n}\n');
    const real = fs.realpathSync(bare);
    const problems = await releaseRefusalProblems({
      label: 'release for an uninitialized directory',
      root: real,
      clientHello: controlHello(),
      code: INVALID_PARAMS_CODE,
      message: /not initialized/,
      absent: [path.join(real, '.codegraph'), path.join(real, '.codegraph', 'rebuild.pid')],
      present: [path.join(real, 'src', 'a.ts')],
    });
    expect([...serverProblems, ...problems], 'RF3 problems (empty when the uninitialized release is refused with -32602 and creates nothing)').toEqual([]);
  });

  // RF4: a connection whose hello has no control marker is not the CLI: its release is refused with InvalidRequest, and
  // the indexed root keeps its database and takes no rebuild.pid.
  it('RF4 release refusal: a hello without the control marker gets -32600 for a release, and the indexed root keeps its index', async () => {
    const problems = await releaseRefusalProblems({
      label: 'release from a hello without the control marker',
      root: U4,
      clientHello: { codegraph_client: 1, pid: process.pid, hostPid: null },
      code: REFUSED_CODE,
      message: null,
      absent: [path.join(getCodeGraphDir(U4), 'rebuild.pid')],
      present: [path.join(getCodeGraphDir(U4), 'codegraph.db')],
    });
    expect([...serverProblems, ...problems], 'RF4 problems (empty when the unmarked release is refused with -32600 and the index is kept)').toEqual([]);
  });
});

describe('uninit releases the index before it deletes it (UG1b)', () => {
  const fx = new Fixtures();

  afterAll(async () => {
    await fx.teardown();
  }, 120_000);

  // UG1b: the release request reaches the server while .codegraph exists, and the lease end after it is gone. The stand-in
  // listens on a unix socket path, which is a named pipe on Windows, so the gate is POSIX-only.
  it.runIf(process.platform !== 'win32')('UG1b ordering: the server is asked to release the index before the CLI deletes .codegraph, and the lease ends after the delete', async () => {
    // Over 5 s at load 45-100: an in-process index of one small project (one CLI start), then one CLI uninit (a second
    // CLI start) with the stand-in server answering it.
    const dir = fx.tempRoot();
    const state = path.join(dir, 'state');
    const repo = plainProject(path.join(dir, 'proj'), 'ug1bBase');
    fx.index(repo, state);
    // The in-process index does not create the state dir; the stand-in writes its server.pid into it.
    fs.mkdirSync(state, { recursive: true });
    const codegraphDir = getCodeGraphDir(repo);
    const problems: string[] = [];
    const stand = await startStandIn(state);
    try {
      const run = await runCli(['uninit', '--force', repo], state, dir);
      problems.push(...exitProblems('codegraph uninit --force', run));
      const release = stand.requests.find(
        (r) => r.method === INDEX_WRITE_METHOD && r.op === 'release' && sameDir(r.root, repo),
      );
      if (release === undefined) {
        problems.push(
          `no codegraph/indexWrite release request for ${repo} reached the server before the delete: ` +
            `the requests it saw were ${describeRequests(stand.requests)}`,
        );
      } else if (release.rootIndexExisted !== true) {
        problems.push(`the release request for ${repo} arrived after ${codegraphDir} was already gone`);
      }
      const end = stand.requests.find((r) => r.method === INDEX_WRITE_END_METHOD && sameDir(r.root, repo));
      if (end === undefined) {
        problems.push(`no codegraph/indexWriteEnd for ${repo} reached the server: the lease is not ended`);
      } else if (end.rootIndexExisted !== false) {
        problems.push(`the codegraph/indexWriteEnd for ${repo} arrived while ${codegraphDir} still existed`);
      }
      if (fs.existsSync(codegraphDir)) problems.push(`${codegraphDir} still exists after the uninit`);
    } finally {
      await stand.stop();
    }
    expect(
      problems,
      'UG1b problems (empty when the server is asked to release before the delete, and the lease ends after it)',
    ).toEqual([]);
  }, 300_000);
});

describe('uninit with no server running (UG2)', () => {
  const fx = new Fixtures();

  afterAll(async () => {
    await fx.teardown();
  }, 120_000);

  // UG2: with no server, the deletion is the in-process one, and its output is the success line alone.
  it('UG2 none running: uninit --force deletes the index, exits 0, and prints the success line', async () => {
    // Over 5 s at load 45-100: an in-process index of one small project, then a CLI uninit.
    const dir = fx.tempRoot();
    const state = path.join(dir, 'state');
    const repo = plainProject(path.join(dir, 'proj'), 'ug2Base');
    fx.index(repo, state);
    const run = await runCli(['uninit', '--force', repo], state, dir);
    const problems = exitProblems('codegraph uninit --force', run);
    const out = normalise(run.stdout, repo).trim();
    if (!successLine('Removed CodeGraph from <ROOT>').test(out)) {
      problems.push(`stdout is not the success line for the uninit: ${JSON.stringify(tail(out))}`);
    }
    if (fs.existsSync(getCodeGraphDir(repo))) problems.push(`${getCodeGraphDir(repo)} still exists after the uninit`);
    expect(problems, 'UG2 problems (empty when uninit --force exits 0, prints the success line, and deletes the index)').toEqual([]);
  }, 300_000);

  // UG2 no-pid-files: with no server, the uninit writes no server.pid, builder.pid or builder.log in the state dir.
  it('UG2 no-pid-files: uninit --force with no server writes no server.pid or builder.pid into the state dir', async () => {
    // Over 5 s at load 45-100: an in-process index of one small project, then a CLI uninit.
    const dir = fx.tempRoot();
    const state = path.join(dir, 'state');
    const repo = plainProject(path.join(dir, 'proj'), 'ug2PidBase');
    fx.index(repo, state);
    const run = await runCli(['uninit', '--force', repo], state, dir);
    const problems = exitProblems('codegraph uninit --force', run);
    for (const file of ['server.pid', 'builder.pid', 'builder.log']) {
      if (fs.existsSync(path.join(state, file))) problems.push(`${file} exists in the state dir after the uninit`);
    }
    expect(problems, 'UG2 no-pid-files problems (empty when the uninit exits 0 and writes no pid file into the state dir)').toEqual([]);
  }, 300_000);
});

describe('unlock: a live holder keeps its lock, a stale one is taken (UL1, UL2)', () => {
  const fx = new Fixtures();
  /** Child processes the tests start as live holders; killed in afterAll. */
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await fx.teardown();
  }, 120_000);

  /** An indexed plain project, with the state dir its CLI runs use. */
  function indexedRoot(): { root: string; state: string; dir: string } {
    const dir = fx.tempRoot();
    const state = path.join(dir, 'state');
    const root = plainProject(path.join(dir, 'proj'), 'ulBase');
    fx.index(root, state);
    return { root, state, dir };
  }

  // UL1: a lock whose holder is running is kept: the unlock refuses, names the pid, and leaves the file as it was.
  it('UL1 live holder: unlock names the live pid, exits 1, and leaves codegraph.lock as it was', async () => {
    // Over 5 s at load 45-100: an index of one small project, a live child process, and one CLI unlock.
    const { root, state, dir } = indexedRoot();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    const pid = child.pid;
    if (pid === undefined) throw new Error('could not spawn the live holder');
    const stamp = stampFor(root, pid);
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    const body = `${pid}\n${JSON.stringify(stamp)}`;
    fs.writeFileSync(lockPath, body);
    const problems: string[] = [];
    // Precondition: the record reads as this root's own live holder, so the unlock judges it by liveness alone.
    if (isForeignLockRecord(stamp, root)) {
      problems.push(`precondition: the stamp for live pid ${pid} reads as foreign, so the gate does not test a live holder`);
    }
    const run = await runCli(['unlock', root], state, dir);
    if (run.status !== 1) problems.push(`unlock exited ${String(run.status)} (expected 1): stderr ${JSON.stringify(tail(run.stderr))}`);
    const held = `${lockPath} is held by a live process (pid ${pid}); nothing removed.`;
    if (!new RegExp(`(?:✗|\\[ERR\\]) ${escapeRegExp(held)}`).test(plain(run.stderr))) {
      problems.push(`stderr does not name the live holder (expected "${held}"): ${JSON.stringify(tail(run.stderr))}`);
    }
    if (!fs.existsSync(lockPath)) {
      problems.push(`${lockPath} was taken although its holder (pid ${pid}) is running`);
    } else if (fs.readFileSync(lockPath, 'utf8') !== body) {
      problems.push(`${lockPath} changed: it was not left as it was`);
    }
    expect(problems, 'UL1 problems (empty when unlock exits 1, names the live pid, and leaves the lock file as it was)').toEqual([]);
  }, 300_000);

  // UL2: a lock whose pid has exited is stale and is taken, with the success line and exit 0.
  it('UL2 dead owner: unlock takes a lock whose pid has exited, exits 0, and prints the stale-lock success line', async () => {
    // Over 5 s at load 45-100: an index of one small project, a child that exits, and one CLI unlock.
    const { root, state, dir } = indexedRoot();
    const dead = await deadPid();
    if (isAlive(dead)) throw new Error(`pid ${dead} is still running, so it is not a dead owner`);
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockPath, `${dead}\n${JSON.stringify(stampFor(root, dead))}`);
    const run = await runCli(['unlock', root], state, dir);
    const problems = exitProblems('codegraph unlock', run);
    if (!successLine('Removed stale lock artifacts. You can now run indexing again.').test(plain(run.stdout).trim())) {
      problems.push(`stdout is not the stale-lock success line: ${JSON.stringify(tail(run.stdout))}`);
    }
    if (fs.existsSync(lockPath)) problems.push(`${lockPath} still exists after unlock`);
    expect(problems, 'UL2 dead-owner problems (empty when unlock exits 0, prints the success line, and takes the lock)').toEqual([]);
  }, 300_000);

  // UL2 (non-numeric body): a lock whose first line is not a pid is stale and is taken.
  it('UL2 non-numeric body: unlock takes a lock whose first line is not a pid, exits 0, and prints the stale-lock success line', async () => {
    // Over 5 s at load 45-100: an index of one small project and one CLI unlock.
    const { root, state, dir } = indexedRoot();
    const lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockPath, 'stale\n');
    const run = await runCli(['unlock', root], state, dir);
    const problems = exitProblems('codegraph unlock', run);
    if (!successLine('Removed stale lock artifacts. You can now run indexing again.').test(plain(run.stdout).trim())) {
      problems.push(`stdout is not the stale-lock success line: ${JSON.stringify(tail(run.stdout))}`);
    }
    if (fs.existsSync(lockPath)) problems.push(`${lockPath} still exists after unlock`);
    expect(problems, 'UL2 non-numeric-body problems (empty when unlock exits 0, prints the success line, and takes the lock)').toEqual([]);
  }, 300_000);
});

describe('unlock: links, directories, and owners the lock rule reads (UL3-UL8)', () => {
  const fx = new Fixtures();
  /** Child processes started as live owners; killed in afterAll. */
  const children: ChildProcess[] = [];
  /** The state dir the CLI runs use, the directory they start in, and the one indexed project every case unlocks. */
  let dir = '';
  let state = '';
  let root = '';
  /** The lock path under the project's `.codegraph`. Each case leaves its lock here; afterEach removes whatever it left. */
  let lockPath = '';

  beforeAll(() => {
    dir = fx.tempRoot();
    state = path.join(dir, 'state');
    root = plainProject(path.join(dir, 'proj'), 'ulEdgeBase');
    fx.index(root, state);
    lockPath = path.join(getCodeGraphDir(root), 'codegraph.lock');
  }, 300_000);

  afterEach(() => {
    // Removes a link as a link (never its target), and a directory with what is in it.
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await fx.teardown();
  }, 120_000);

  /** A live process to name as a lock's owner. Started here, killed in afterAll. */
  function liveOwner(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    if (child.pid === undefined) throw new Error('could not spawn the live owner');
    return child.pid;
  }

  /** A file outside the project's `.codegraph`, holding `body`: what a symlink at the lock points to. */
  function fileOutside(name: string, body: string): string {
    const target = path.join(dir, 'targets', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return target;
  }

  const STALE_SUCCESS = 'Removed stale lock artifacts. You can now run indexing again.';

  // UL3: a link at the lock is judged as the lock it is, and only the link is removed. The file it points to is not the
  // lock, so it stays as it was.
  it.runIf(process.platform !== 'win32')('UL3 symlink, dead owner: unlock removes only the link, leaves the file it points to, and exits 0', async () => {
    const dead = await deadPid();
    const problems: string[] = [];
    if (isAlive(dead)) problems.push(`precondition: pid ${dead} is still running, so it is not a dead owner`);
    const body = `${dead}\n${JSON.stringify(stampFor(root, dead))}`;
    const target = fileOutside('ul3.lock', body);
    fs.symlinkSync(target, lockPath);
    const run = await runCli(['unlock', root], state, dir);
    problems.push(...exitProblems('codegraph unlock', run));
    if (!successLine(STALE_SUCCESS).test(plain(run.stdout).trim())) {
      problems.push(`stdout is not the stale-lock success line: ${JSON.stringify(tail(run.stdout))}`);
    }
    if (entryKind(lockPath) !== 'missing') problems.push(`${lockPath} is still a ${entryKind(lockPath)} after unlock`);
    if (readOrNull(target) !== body) problems.push(`${target}, the file the link pointed to, is gone or changed`);
    expect(problems, 'UL3 problems (empty when unlock exits 0, prints the success line, removes only the link, and leaves its target as it was)').toEqual([]);
  }, 300_000);

  // UL4: a link to a live owner's lock is refused, and neither the link nor what it points to changes. The judgement is
  // of the pid the lock names; the link is not a reason to take it out.
  it.runIf(process.platform !== 'win32')('UL4 symlink, live owner: unlock exits 1 and leaves the link and the file it points to as they were', async () => {
    const pid = liveOwner();
    const stamp = stampFor(root, pid);
    const problems: string[] = [];
    if (isForeignLockRecord(stamp, root)) problems.push(`precondition: the stamp for live pid ${pid} reads as foreign`);
    const body = `${pid}\n${JSON.stringify(stamp)}`;
    const target = fileOutside('ul4.lock', body);
    fs.symlinkSync(target, lockPath);
    const run = await runCli(['unlock', root], state, dir);
    if (run.status !== 1) problems.push(`unlock exited ${String(run.status)} (expected 1): stderr ${JSON.stringify(tail(run.stderr))}`);
    if (plain(run.stdout).includes('Removed stale lock')) problems.push('stdout reports a removal for a live owner');
    if (entryKind(lockPath) !== 'symlink') {
      problems.push(`${lockPath} is now a ${entryKind(lockPath)}, not the link it was`);
    } else if (fs.readlinkSync(lockPath) !== target) {
      problems.push(`${lockPath} now points at ${fs.readlinkSync(lockPath)}, not ${target}`);
    }
    if (readOrNull(target) !== body) problems.push(`${target}, the file the link points to, is gone or changed`);
    expect(problems, 'UL4 problems (empty when unlock exits 1 and leaves the link and its target as they were)').toEqual([]);
  }, 300_000);

  // UL5: a directory where the lock should be is not a lock. Unlock refuses it, and nothing inside it is removed.
  it('UL5 directory: unlock exits 1, and the directory and what is in it are left as they were', async () => {
    fs.mkdirSync(lockPath);
    const keep = path.join(lockPath, 'keep.txt');
    const keptBody = 'a file inside the directory at the lock path\n';
    fs.writeFileSync(keep, keptBody);
    const run = await runCli(['unlock', root], state, dir);
    const problems: string[] = [];
    if (run.status !== 1) problems.push(`unlock exited ${String(run.status)} (expected 1): stderr ${JSON.stringify(tail(run.stderr))}`);
    if (successLine(STALE_SUCCESS).test(plain(run.stdout).trim())) problems.push('stdout is the stale-lock success line: a directory was taken as a lock');
    if (entryKind(lockPath) !== 'directory') problems.push(`${lockPath} is now a ${entryKind(lockPath)}, not the directory it was`);
    if (readOrNull(keep) !== keptBody) problems.push(`${keep} is gone or changed`);
    expect(problems, 'UL5 problems (empty when unlock exits 1 and leaves the directory and its contents as they were)').toEqual([]);
  }, 300_000);

  // UL6: a first line that is not a pid above zero names no process. The lock is stale, and it is taken. Zero is the
  // case that matters: signal 0 to pid 0 reaches this process group, so it must never be read as a live holder.
  for (const first of ['0', '-1']) {
    it(`UL6 first line ${first}: unlock takes a lock whose first line names no process, exits 0, and prints the stale-lock success line`, async () => {
      fs.writeFileSync(lockPath, `${first}\n`);
      const run = await runCli(['unlock', root], state, dir);
      const problems = exitProblems('codegraph unlock', run);
      if (!successLine(STALE_SUCCESS).test(plain(run.stdout).trim())) {
        problems.push(`stdout is not the stale-lock success line: ${JSON.stringify(tail(run.stdout))}`);
      }
      if (entryKind(lockPath) !== 'missing') problems.push(`${lockPath} still exists after unlock`);
      expect(problems, `UL6 first-line-${first} problems (empty when unlock exits 0, prints the success line, and takes the lock)`).toEqual([]);
    }, 300_000);
  }

  // UL7: pid 1 is running, and this user may not signal it (EPERM). unlock reads EPERM as running, so the lock is held
  // and is kept. It is the case that tells "may not signal" apart from "not running".
  it('UL7 pid 1: unlock refuses a lock whose holder is pid 1 (running, not signalable here): exit 1, the lock kept as it was', async () => {
    const problems: string[] = [];
    if (!isAlive(1)) problems.push('precondition: pid 1 does not read as running here, so the case does not test a live holder');
    const body = '1\n';
    fs.writeFileSync(lockPath, body);
    const run = await runCli(['unlock', root], state, dir);
    if (run.status !== 1) problems.push(`unlock exited ${String(run.status)} (expected 1): stderr ${JSON.stringify(tail(run.stderr))}`);
    const held = `${lockPath} is held by a live process (pid 1); nothing removed.`;
    if (!new RegExp(`(?:✗|\\[ERR\\]) ${escapeRegExp(held)}`).test(plain(run.stderr))) {
      problems.push(`stderr does not name pid 1 (expected "${held}"): ${JSON.stringify(tail(run.stderr))}`);
    }
    if (readOrNull(lockPath) !== body) problems.push(`${lockPath} changed or was removed: it was not left as it was`);
    expect(problems, 'UL7 problems (empty when unlock exits 1, names pid 1, and leaves the lock as it was)').toEqual([]);
  }, 300_000);

  // UL8: a live pid whose owner record names another project and another index is a copied-in lock, not this project's
  // holder: the record decides, whatever the pid, so the lock is stale.
  it('UL8 live pid with a foreign owner record: unlock takes the lock, exits 0, and prints the stale-lock success line', async () => {
    const pid = liveOwner();
    const own = stampFor(root, pid);
    const foreign = { ...own, root: path.join(dir, 'copied-from-elsewhere'), dirId: 'foreign-dir-id', dbId: 'foreign-db-id' };
    const problems: string[] = [];
    if (!isForeignLockRecord(foreign, root)) problems.push('precondition: the record reads as this project\'s own, so the case does not test a foreign owner');
    if (!isAlive(pid)) problems.push(`precondition: pid ${pid} is not running`);
    fs.writeFileSync(lockPath, `${pid}\n${JSON.stringify(foreign)}`);
    const run = await runCli(['unlock', root], state, dir);
    problems.push(...exitProblems('codegraph unlock', run));
    if (!successLine(STALE_SUCCESS).test(plain(run.stdout).trim())) {
      problems.push(`stdout is not the stale-lock success line: ${JSON.stringify(tail(run.stdout))}`);
    }
    if (entryKind(lockPath) !== 'missing') problems.push(`${lockPath} still exists after unlock`);
    expect(problems, 'UL8 problems (empty when unlock exits 0, prints the success line, and takes the foreign-owned lock)').toEqual([]);
  }, 300_000);
});

describe('the open-file inspection the holder checks use (openUnder)', () => {
  // A dead pid is a failed inspection, not an empty list: lsof names nothing for it, and the poll that asks would read
  // "no holder" as a result. The helper throws, so the test that asked fails with the reason.
  it.runIf(LSOF_AVAILABLE)('a dead pid is a failed inspection: openUnder throws instead of returning no open files', async () => {
    const dead = await deadPid();
    expect(() => openUnder(dead, '/')).toThrow(/not running/);
  });

  // The positive control: a running pid answers with its files, and none of them is under a directory that is not there.
  it.runIf(LSOF_AVAILABLE)('a running pid answers without throwing, and names no file under a directory that does not exist', () => {
    expect(openUnder(process.pid, '/nonexistent-codegraph-openunder-check')).toEqual([]);
  });
});
