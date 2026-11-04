/**
 * Harness for the machine-server gates (`machine-server.gate.test.ts`).
 *
 * Every gate drives the built CLI the way an agent host does: `serve --mcp`
 * over stdio, JSON-RPC requests in, JSON-RPC responses and stderr out. The
 * harness imports nothing from the server's own modules except the Node
 * runtime flags every spawning suite passes.
 *
 * Teardown is part of the harness. Each session's launcher is preloaded with
 * the spawn recorder (`__tests__/fixtures/record-detached-spawns.cjs`), so the
 * pid of every detached server it starts lands in a log beside the state dir.
 * The pids a session reports in its attach log and the pid in
 * `<state>/server.pid` are collected too. `Fixtures.teardown` ends every
 * session and stops every collected pid that is still a codegraph process, so
 * no server outlives the test that started it.
 */
import { ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';

export const REPO = path.resolve(__dirname, '../../..');
export const BIN = path.join(REPO, 'dist/bin/codegraph.js');
const SPAWN_RECORDER = path.join(REPO, '__tests__/fixtures/record-detached-spawns.cjs');

/**
 * The text a `codegraph_explore` call without a `projectPath` answers with
 * (repo-anchor.ts MISSING_PROJECT_PATH_TEXT). Written out here, not imported, so the gate
 * checks the wording a host sees.
 */
export const MISSING_PROJECT_PATH_TEXT = 'missing argument: root path to the code you wish to query';

/**
 * `lsof` counts a server's open databases on POSIX only. Where it is missing
 * the database-count gate is skipped rather than failed.
 */
export const LSOF_AVAILABLE = process.platform !== 'win32' && !spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error;

/**
 * Variables a developer's shell may export that would change what a gate
 * measures. A gate sets the ones it depends on through its own env.
 */
const SCRUBBED_ENV = [
  'CODEGRAPH_NO_DAEMON',
  'CODEGRAPH_STATE_DIR',
  'CODEGRAPH_MCP_LOG_ATTACH',
  'CODEGRAPH_MCP_TOOLS',
  'CODEGRAPH_EXTENSION_MODULES',
  'CODEGRAPH_NO_RELAUNCH',
  'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
  'CODEGRAPH_DAEMON_MAX_IDLE_MS',
  'CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS',
];

/**
 * The environment of every codegraph process a gate starts. HOME is already
 * sandboxed for the whole file by `setup-home-sandbox.ts`.
 */
export function gateEnv(stateDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return {
    ...env,
    CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    CODEGRAPH_STATE_DIR: stateDir,
    ...extra,
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `pred` every `intervalMs`: true as soon as it holds, false when
 * `timeoutMs` passes first. Callers that poll a subprocess (lsof) pass a longer
 * interval than the 25 ms default, so the poll itself does not load the machine.
 */
export async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Whether `pid` names a running process. `kill(pid, 0)` also succeeds for a
 * zombie (exited, not yet reaped), so on POSIX a zombie counts as not running.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform === 'win32') return true;
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error) return true;
  const stat = (ps.stdout ?? '').trim();
  return stat !== '' && !stat.startsWith('Z');
}

/**
 * Whether `pid` is still a codegraph process. A recorded pid can be reused by
 * an unrelated process once the server has exited, so teardown checks the
 * command line before it signals anything.
 */
function isCodegraphProcess(pid: number): boolean {
  if (!isAlive(pid)) return false;
  if (process.platform === 'win32') return true;
  const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (cmd.error) return true;
  return (cmd.stdout ?? '').includes('codegraph');
}

/** SIGTERM, a 3 s grace, then SIGKILL. */
export async function stopProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitUntil(() => !isAlive(pid), 3_000)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* exited between the checks */
  }
  await waitUntil(() => !isAlive(pid), 2_000);
}

/** The pid in `<state>/server.pid`, or null when that file is absent or unreadable. */
export function serverPidOf(stateDir: string): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8')) as { pid?: unknown };
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

/** The distinct `codegraph.db` files (not the -wal or -shm siblings) the process holds open, by path. */
export function openCodegraphDbs(pid: number): string[] {
  const res = spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
  const names = (res.stdout ?? '').split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  return [...new Set(names.filter((name) => path.basename(name) === 'codegraph.db'))].sort();
}

/** Pids the spawn recorder logged for the detached servers a launcher started. */
function recordedPids(log: string): number[] {
  let raw = '';
  try {
    raw = fs.readFileSync(log, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

function git(cwd: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=machine-server-gate', '-c', 'user.email=gate@codegraph.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** What a gate reads from one tools/call: its text, its isError flag, and any JSON-RPC error. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
  rpcError: string | null;
}

/**
 * The phrase explore answers with when nothing matched. It echoes the query, so
 * a text that merely names the queried symbol proves nothing: a retrieval is
 * proven by source coming back, which a fixture marks with a body marker.
 */
export const NO_RESULT_PHRASE = 'No relevant code found';

/**
 * True when the call answered without error and returned the source of
 * `symbol`: its text names the symbol AND contains `bodyMarker`, a string
 * literal that only that definition's body holds (so it appears only when the
 * body came back, never in an echo of the query), and is not a no-result answer.
 */
export function answers(ans: ToolAnswer, symbol: string, bodyMarker: string): boolean {
  return (
    !ans.isError &&
    ans.rpcError === null &&
    ans.text.includes(symbol) &&
    ans.text.includes(bodyMarker) &&
    !ans.text.includes(NO_RESULT_PHRASE)
  );
}

/** A one-line excerpt of an answer, for a failure message. */
export function excerpt(ans: ToolAnswer): string {
  const body = ans.rpcError ?? ans.text;
  const shown = JSON.stringify(body.slice(0, 160)) + (body.length > 160 ? '...' : '');
  return ans.isError ? `${shown} (isError)` : shown;
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

export interface SessionOptions {
  /** The launch directory: the session's cwd, as a host starts `serve --mcp`. */
  cwd: string;
  /** Set as CODEGRAPH_STATE_DIR for this session. */
  stateDir: string;
  /** Extra environment for this session only. */
  env?: Record<string, string>;
  /** Arguments appended after `serve --mcp`, e.g. `['--focus', 'src/app']`. Omitted: none. */
  args?: string[];
}

/**
 * One `codegraph serve --mcp` process driven over stdio. Requests resolve on
 * their matching response. A request rejects only on a timeout or when the
 * launcher exits first; a JSON-RPC error comes back as `rpcError`.
 */
export class McpSession {
  readonly cwd: string;
  readonly stateDir: string;
  /** The spawn recorder's log for this session's launcher (beside the state dir). */
  readonly spawnLog: string;
  readonly child: ChildProcessWithoutNullStreams;
  private exited = false;
  private instructionsText: string | null = null;
  private stdoutBuf = '';
  private stderrText = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (msg: JsonRpcMessage | Error) => void>();

  constructor(opts: SessionOptions) {
    this.cwd = opts.cwd;
    this.stateDir = opts.stateDir;
    this.spawnLog = path.join(path.dirname(opts.stateDir), 'spawns.log');
    this.child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, '--require', SPAWN_RECORDER, BIN, 'serve', '--mcp', ...(opts.args ?? [])], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: gateEnv(opts.stateDir, { CODEGRAPH_MCP_LOG_ATTACH: '1', CG_TEST_SPAWN_LOG: this.spawnLog, ...opts.env }),
    });
    // A failed spawn ends the session; the pending request then reports it.
    this.child.on('error', () => { /* see above */ });
    this.child.stdin.on('error', () => { /* the launcher is gone; the pending request reports it */ });
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrText += chunk.toString('utf8'); });
    this.child.on('exit', () => {
      this.exited = true;
      for (const settle of [...this.waiting.values()]) {
        settle(new Error(`the launcher exited before it answered; stderr tail:\n${this.stderrTail()}`));
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  stderrTail(): string {
    return this.stderrText.slice(-1500);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (let nl = this.stdoutBuf.indexOf('\n'); nl !== -1; nl = this.stdoutBuf.indexOf('\n')) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number') this.waiting.get(msg.id)?.(msg);
    }
  }

  private write(msg: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* the launcher is gone; the pending request reports it */
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new Error(`no answer to ${method} within ${timeoutMs} ms; stderr tail:\n${this.stderrTail()}`)),
        timeoutMs,
      );
      const settle = (value: JsonRpcMessage | Error): void => {
        clearTimeout(timer);
        this.waiting.delete(id);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      this.waiting.set(id, settle);
      if (this.exited) {
        settle(new Error(`the launcher had already exited when ${method} was sent; stderr tail:\n${this.stderrTail()}`));
        return;
      }
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** The initialize handshake a host performs, including the initialized notification. */
  async initialize(): Promise<void> {
    const res = await this.request(
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'machine-server-gate', version: '0.0.0' },
        rootUri: pathToFileURL(this.cwd).href,
      },
      60_000,
    );
    if (res.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(res.error)}`);
    const init = (res.result ?? {}) as { instructions?: unknown };
    this.instructionsText = typeof init.instructions === 'string' ? init.instructions : null;
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** The `instructions` the server sent in its initialize answer, or null before initialize or when it sent none. */
  get instructions(): string | null {
    return this.instructionsText;
  }

  /** One tools/call, as an agent makes it. */
  async tool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolAnswer> {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res.error !== undefined) return { text: '', isError: true, rpcError: JSON.stringify(res.error) };
    const result = (res.result ?? {}) as { content?: Array<{ text?: unknown }>; isError?: unknown };
    const first = result.content?.[0]?.text;
    return { text: typeof first === 'string' ? first : '', isError: result.isError === true, rpcError: null };
  }

  /** The names in this session's tools/list answer, in the order the server gave them. */
  async listTools(): Promise<string[]> {
    const res = await this.request('tools/list', {}, 60_000);
    if (res.error !== undefined) throw new Error(`tools/list failed: ${JSON.stringify(res.error)}`);
    const result = (res.result ?? {}) as { tools?: Array<{ name?: unknown }> };
    return (result.tools ?? []).map((tool) => String(tool.name));
  }

  /** Every server pid named in this session's attach log lines, in order. */
  attachedPids(): number[] {
    return [...this.stderrText.matchAll(/Attached to shared daemon on .*? \(pid (\d+),/g)].map((m) => Number(m[1]));
  }

  /**
   * The pid of the server this session attached to (the last attach line),
   * or null when no attach line is logged within `timeoutMs`.
   */
  async attachedPid(timeoutMs = 15_000): Promise<number | null> {
    await waitUntil(() => this.attachedPids().length > 0 || this.exited, timeoutMs);
    const pids = this.attachedPids();
    return pids.length > 0 ? pids[pids.length - 1]! : null;
  }

  /**
   * Closes the client: stdin ends and the launcher exits. The launcher is
   * killed if it has not gone within `graceMs`.
   */
  async end(graceMs = 5_000): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (await waitUntil(() => this.exited, graceMs)) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* gone */
    }
    await waitUntil(() => this.exited, 3_000);
  }
}

/**
 * The per-describe scratch area: temp roots, sessions, and the teardown that
 * stops every server a test started. Use one per describe, with
 * `afterEach(() => fx.teardown(), 60_000)`.
 */
export class Fixtures {
  private readonly roots: string[] = [];
  private readonly sessions: McpSession[] = [];

  /** A new temp directory, realpath'd (macOS /var is a symlink into /private). Removed by teardown. */
  tempRoot(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-machine-server-')));
    this.roots.push(dir);
    return dir;
  }

  /** A git repository with `files` committed. Returns its realpath. */
  makeRepo(dir: string, files: Record<string, string>): string {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    writeFiles(dir, files);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    return fs.realpathSync(dir);
  }

  /** A linked worktree of `repo` on a new branch. Returns its realpath. */
  addWorktree(repo: string, branch: string, dir: string): string {
    git(repo, ['worktree', 'add', '-q', '-b', branch, dir]);
    return fs.realpathSync(dir);
  }

  /** Writes `files` into `dir` and commits them there. */
  commitFiles(dir: string, files: Record<string, string>, message: string): void {
    writeFiles(dir, files);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', message]);
  }

  /** `codegraph init --yes <dir>`, the CLI's index build, with CODEGRAPH_STATE_DIR set. */
  index(dir: string, stateDir: string): void {
    execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'init', '--yes', dir], {
      env: gateEnv(stateDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  }

  /**
   * `codegraph project pin <dir>` under the same state dir the sessions use. The
   * registry is `<state>/projects` (project-registry.ts, `registryDir`), so the pin
   * and the sessions must share CODEGRAPH_STATE_DIR.
   */
  pin(dir: string, stateDir: string): void {
    execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'project', 'pin', dir], {
      env: gateEnv(stateDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  }

  /** `codegraph project unpin <dir>` under the same state dir as {@link Fixtures.pin}. */
  unpin(dir: string, stateDir: string): void {
    execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'project', 'unpin', dir], {
      env: gateEnv(stateDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  }

  /** A `serve --mcp` session, started and tracked for teardown. */
  session(opts: SessionOptions): McpSession {
    const session = new McpSession(opts);
    this.sessions.push(session);
    return session;
  }

  /**
   * Ends every session, stops every codegraph server the test started, and
   * removes the temp roots. Never throws: a teardown failure must not hide
   * the test's own result.
   */
  async teardown(): Promise<void> {
    for (const session of this.sessions) await session.end(2_000).catch(() => undefined);
    const pids = new Set<number>();
    for (const session of this.sessions) {
      if (session.pid !== undefined) pids.add(session.pid);
      for (const pid of session.attachedPids()) pids.add(pid);
      for (const pid of recordedPids(session.spawnLog)) pids.add(pid);
      const serverPid = serverPidOf(session.stateDir);
      if (serverPid !== null) pids.add(serverPid);
    }
    await Promise.all([...pids].filter((pid) => isCodegraphProcess(pid)).map((pid) => stopProcess(pid))).catch(() => undefined);
    for (const root of this.roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* a server that survived the stop still holds it; the OS clears the temp dir later */
      }
    }
    this.sessions.length = 0;
    this.roots.length = 0;
  }
}

/**
 * The builder's pid from `<state>/builder.pid` (JSON `{pid, serverPid, startedAt}`), or null while the
 * file is absent (no builder has started in this state dir) or unreadable.
 */
export function builderPidOf(stateDir: string): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'builder.pid'), 'utf8')) as { pid?: unknown };
    return typeof record.pid === 'number' ? record.pid : null;
  } catch {
    return null;
  }
}

/**
 * The lines of `<state>/builder.log` in file order: one `job start` and one `job end` line per job. Blank
 * lines are dropped, so a line's index here is the same on every read. Empty while the log is absent.
 */
export function builderLogLines(stateDir: string): string[] {
  try {
    return fs.readFileSync(path.join(stateDir, 'builder.log'), 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

/** The lock files a project writer can hold under `<root>/.codegraph`. */
export type LockFileName = 'writer.pid' | 'rebuild.pid' | 'codegraph.lock';

/**
 * The holder pids the lock files under `<root>/.codegraph` name. `writer.pid` and `rebuild.pid` are JSON
 * records with a numeric `pid`; `codegraph.lock` is the bare pid on its first line, then a JSON stamp. A
 * file that is absent, empty or unparseable names no holder.
 */
export function lockFileHolders(projectRoot: string): Array<{ file: LockFileName; pid: number }> {
  const holders: Array<{ file: LockFileName; pid: number }> = [];
  for (const file of ['writer.pid', 'rebuild.pid'] as const) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(projectRoot, '.codegraph', file), 'utf8')) as { pid?: unknown };
      if (typeof record.pid === 'number') holders.push({ file, pid: record.pid });
    } catch {
      /* absent, or not a whole record yet */
    }
  }
  try {
    const first = (fs.readFileSync(path.join(projectRoot, '.codegraph', 'codegraph.lock'), 'utf8').split('\n')[0] ?? '').trim();
    const pid = Number.parseInt(first, 10);
    if (Number.isSafeInteger(pid) && pid > 0) holders.push({ file: 'codegraph.lock', pid });
  } catch {
    /* absent */
  }
  return holders;
}

/**
 * Stops `pid` (SIGTERM, then SIGKILL) when it is still a codegraph process. Used for a builder whose
 * server teardown did not stop: a stale pid read from a state dir could name an unrelated process.
 */
export async function stopIfCodegraph(pid: number): Promise<void> {
  if (!isCodegraphProcess(pid)) return;
  await stopProcess(pid);
}
