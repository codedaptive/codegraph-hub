/**
 * Helpers shared by the uninit and unlock gates (`uninit-unlock.gate.test.ts`) and the uninit UG1 validation test
 * (`uninit-unlock-ug1.validation.test.ts`): the CLI run, its output checks, a plain indexed project, and the
 * open-file inspection with lsof.
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../../../src/extraction/wasm-runtime-flags';
import { BIN, gateEnv, isAlive } from './machine-server.harness';

/** How long a server may take to write builder.pid after its start. A cold start at load 45 is slow. */
export const BUILDER_APPEAR_MS = 60_000;
/** The bound on one CLI run: a run that never ends fails here instead of hanging the file. */
const CLI_RUN_MS = 240_000;

/** Strips ANSI escapes and carriage returns, so a line is compared as the terminal shows it. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
export function plain(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE, '');
}

/** The output with the project's path replaced by <ROOT>, so two runs on two projects compare equal. */
export function normalise(text: string, root: string): string {
  return plain(text).split(root).join('<ROOT>');
}

/** The last 400 characters of a text, for a failure message. */
export function tail(text: string): string {
  const t = text.trim();
  return t.length > 400 ? `...${t.slice(-400)}` : t;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a success() line: the success glyph and one space, then the message, and nothing else. success() prints the
 * Unicode glyph where the terminal supports it and the ASCII one elsewhere, so both are accepted.
 */
export function successLine(message: string): RegExp {
  return new RegExp(`^(?:✓|\\[OK\\]) ${escapeRegExp(message)}$`);
}

/** A one-function TypeScript file in `dir/src`, committed to nothing: a plain directory, indexed by the caller. */
export function plainProject(dir: string, symbol: string): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export function ${symbol}(): number {\n  return 1;\n}\n`);
  return fs.realpathSync(dir);
}

/** One CLI run: its exit status, its whole stdout and stderr, and the pid of the process. */
export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
}

/** Runs `dist/bin/codegraph.js` with `args` as a child of this process: non-TTY, the gate environment, `stateDir` set. */
export function runCli(args: string[], stateDir: string, cwd: string): Promise<CliRun> {
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
export function exitProblems(label: string, run: CliRun): string[] {
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
export function openUnder(pid: number, dir: string): string[] {
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
