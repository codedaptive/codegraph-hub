/**
 * Fresh answers, CLI surface: the CLI never closes its writer while
 * the sync its `--fresh` wait started is still running.
 *
 * When `--fresh` passes its bound with a sync in flight, the CLI prints the
 * answer, the not-fresh checkpoint and a `Note:` line at once, then waits
 * (capped by CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS) for that sync to settle before
 * closing the index and exiting 3. Closing the writer mid-sync cuts the sync
 * and leaves files pending for the next caller.
 *
 * The cut is forced with FILE_COUNT changed files and a CODEGRAPH_FRESH_TIMEOUT_MS
 * found by search on this machine (see cutRun). No single bound is a gate: how
 * long a sync takes varies too much with machine load, from one run to the next,
 * to place a bound inside it in one shot. The bound must outlast the wait's
 * first pending count, or the wait times out before it starts a sync at all; and
 * the sync must outlast the bound. The checkpoint is taken at the bound, before
 * the settle wait, so its pending is the cut count. cutRun accepts a run only
 * when that count shows a sync ran and plenty was left in flight
 * (FILE_COUNT * CUT_MIN_LEFT <= pending < FILE_COUNT), so a run without a cut
 * fails as a fixture problem, never as the behaviour under test.
 *
 * Driven through the built binary as __tests__/extensions/host/fresh-answers.cli.test.ts is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { createRequire } from 'module';
import { CodeGraph } from '../../../src';

// Loaded through require: vite's transform drops the `node:` prefix of a static import and then
// cannot resolve `sqlite`.
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite');

const BIN = path.resolve(__dirname, '../../../dist/bin/codegraph.js');
const CHECKPOINT_PREFIX = 'codegraph-checkpoint ';
/** Enough changed files that one sync takes seconds, so a bound can land well inside it. */
const FILE_COUNT = 400;
/** Three lines per function: about 60 lines per file. */
const FUNCS_PER_FILE = 20;
/**
 * A cut is accepted only with at least this share of FILE_COUNT still pending at the bound. With 80
 * or more of 400 files left, the settle wait syncs them for far longer than ORDER_GAP_MS on any
 * machine this runs on, which is what makes the ordering assertions below a gate.
 */
const CUT_MIN_LEFT = 0.2;
/** Bound searches before the fixture gives up. */
const CUT_ATTEMPTS = 5;
/** How long before exit the Note (and the checkpoint) must have arrived when the CLI waits for the settle. */
const ORDER_GAP_MS = 100;
/** A child still running after this is killed; the run then fails on its signal. */
const CHILD_TIMEOUT_MS = 180_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** One stderr line and when the parent received it, in ms since the spawn. */
interface TimedLine { text: string; at: number }

/** A finished CLI run. Times are ms since the spawn, taken in this process as each chunk arrived. */
interface CliRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** When the last stdout chunk arrived; -1 when stdout stayed empty. */
  stdoutAt: number;
  stderr: TimedLine[];
  /** The child's 'exit' event. */
  exitAt: number;
}

/**
 * One child, no daemon, no wasm-flag re-exec, no telemetry or prompt hook.
 * Both fresh env knobs are removed unless the test sets them, so an inherited
 * value cannot change the bound or the settle cap.
 *
 * Async spawn, so each output chunk is timestamped as it arrives: spawnSync would only show that the
 * output appeared at some point, not that it appeared before the settle wait. Resolves on 'close'
 * (all output read); exitAt is the earlier 'exit'.
 */
function runCli(args: string[], extra: Record<string, string> = {}): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1',
    CODEGRAPH_NO_PROMPT_HOOK: '1', CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_WASM_RELAUNCHED: '1',
    NODE_NO_WARNINGS: '1', NO_COLOR: '1',
  };
  delete env.CODEGRAPH_FRESH_TIMEOUT_MS;
  delete env.CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS;
  Object.assign(env, extra);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const now = () => Math.round(performance.now() - t0);
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const killer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
    let stdout = '';
    let stdoutAt = -1;
    let partial = '';
    const stderr: TimedLine[] = [];
    let exitAt = -1;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; stdoutAt = now(); });
    child.stderr.on('data', (chunk: string) => {
      // A line is stamped with the chunk that completes it.
      const at = now();
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop()!;
      for (const text of parts) if (text.trim() !== '') stderr.push({ text, at });
    });
    child.on('exit', () => { exitAt = now(); });
    child.on('error', err => { clearTimeout(killer); reject(err); });
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      if (partial.trim() !== '') stderr.push({ text: partial, at: exitAt });
      resolve({ status, signal, stdout, stdoutAt, stderr, exitAt });
    });
  });
}

/** The `codegraph-checkpoint {...}` stderr lines. */
function checkpointLines(run: CliRun): TimedLine[] {
  return run.stderr.filter(l => l.text.startsWith(CHECKPOINT_PREFIX));
}

/** The query surface's checkpoint: its single stderr line, parsed; undefined unless there is exactly one. */
function stderrCheckpoint(run: CliRun): Record<string, unknown> | undefined {
  const lines = checkpointLines(run);
  if (lines.length !== 1) return undefined;
  try {
    return JSON.parse(lines[0].text.slice(CHECKPOINT_PREFIX.length));
  } catch {
    return undefined;
  }
}

/** The checkpoint command's checkpoint: its stdout JSON; undefined when stdout is not JSON. */
function stdoutCheckpoint(run: CliRun): Record<string, unknown> | undefined {
  try {
    return JSON.parse(run.stdout.trim());
  } catch {
    return undefined;
  }
}

/** Arrival times of the run's output against its exit, for failure messages. */
function describeTimes(run: CliRun): string {
  const marks = run.stderr.map(l => `${JSON.stringify(l.text.slice(0, 40))} +${l.at} ms`);
  return `stdout last +${run.stdoutAt} ms; stderr ${marks.join(', ') || 'none'}; exit +${run.exitAt} ms`;
}

/** `PRAGMA integrity_check` on the index, opened read-only. */
function integrityCheck(dir: string): string {
  const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'), { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    return String(row.integrity_check);
  } finally {
    db.close();
  }
}

/** The starting bound and the two timings it was computed from, all in ms. */
interface Calibration { countMs: number; syncMs: number; boundMs: number }

/**
 * The first bound cutRun tries: round(C * 1.5 + S * 0.3). Only a starting point; cutRun moves it.
 *
 * C is timed here, after the edit: the wait's first step, a writable CodeGraph.open plus
 * getChangedFiles plus destroy. The CLI's clock starts after its own open, so C over-counts the
 * part of the bound the first count uses; the 1.5 is headroom for load moving between this
 * measurement and the run.
 *
 * S is the setup's indexAll of the same FILE_COUNT files, in-process. It stands in for the CLI's sync
 * of FILE_COUNT modified files: same files, same extraction work, plus a delete of each file's old
 * nodes. The 0.3 aims the bound about 30% of the way into the sync.
 */
async function calibrateBound(dir: string, syncMs: number): Promise<Calibration> {
  const t0 = Date.now();
  const cg = await CodeGraph.open(dir);
  try {
    cg.getChangedFiles();
  } finally {
    cg.destroy();
  }
  const countMs = Date.now() - t0;
  return { countMs, syncMs, boundMs: Math.round(countMs * 1.5 + syncMs * 0.3) };
}

/**
 * File i's body. With an attempt number it also carries `freshlyAdded<i>` and a mark unique to the
 * attempt, so every attempt's edit differs from whatever an earlier attempt's sync indexed.
 */
function fileBody(i: number, attempt?: number): string {
  const lines: string[] = [];
  for (let f = 0; f < FUNCS_PER_FILE; f++) {
    lines.push(`export function mod${i}Fn${f}(x: number): number {`);
    lines.push(`  return x + ${f};`);
    lines.push('}');
  }
  if (attempt !== undefined) {
    lines.push(`export function freshlyAdded${i}() {}`);
    lines.push(`export const attemptMark${i} = ${attempt};`);
  }
  return lines.join('\n') + '\n';
}

/** One bound tried by cutRun and what the checkpoint at it said. */
interface Attempt { boundMs: number; pending: unknown; timedOut: unknown; fresh: unknown }

/** The accepted run of cutRun, its checkpoint, and every attempt it took. */
interface Cut { run: CliRun; cp: Record<string, unknown>; attempts: Attempt[]; calibration: Calibration }

describe('fresh answers: CLI with a sync still in flight at the bound', () => {
  let dir: string;
  /** The setup's indexAll wall time: calibrateBound's sync estimate S. */
  let indexAllMs: number;

  // Over 5 s: indexes FILE_COUNT files, and that indexAll's duration is the calibration's S.
  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-inflight-')));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', 'Fresh Test']);
    git(dir, ['config', 'user.email', 'fresh@example.invalid']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    for (let i = 0; i < FILE_COUNT; i++) fs.writeFileSync(path.join(dir, `m${i}.ts`), fileBody(i));
    // .codegraph/ must not show up in `git status`, or dirtyHash would hash the index itself.
    fs.writeFileSync(path.join(dir, '.gitignore'), '.codegraph/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
    const cg = CodeGraph.initSync(dir);
    try {
      const t0 = Date.now();
      await cg.indexAll();
      indexAllMs = Date.now() - t0;
    } finally {
      cg.destroy();
    }
  }, 120_000);

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Rewrites every file with attempt `n`'s body, so all FILE_COUNT are pending again. */
  function editAll(n: number): void {
    for (let i = 0; i < FILE_COUNT; i++) fs.writeFileSync(path.join(dir, `m${i}.ts`), fileBody(i, n));
  }

  /**
   * Runs `args` until its checkpoint shows a cut sync: timedOut true and
   * FILE_COUNT * CUT_MIN_LEFT <= pending < FILE_COUNT. Up to CUT_ATTEMPTS tries, from calibrateBound's
   * bound. Every try first rewrites all files and checks a plain checkpoint reports all FILE_COUNT
   * pending: a missed try's sync may have committed files (settled before exit, or cut and left), and
   * this puts every try on the same start. pending FILE_COUNT (no sync started) or no count raises
   * the bound; fewer than the minimum left (the sync finished or nearly) lowers it. x2 / x0.5 until a
   * miss on each side is known, then the geometric mean of the closest two.
   */
  async function cutRun(
    args: string[], extra: Record<string, string>, readCp: (run: CliRun) => Record<string, unknown> | undefined,
  ): Promise<Cut> {
    const attempts: Attempt[] = [];
    let calibration: Calibration | undefined;
    let bound = 0;
    let tooShort: number | undefined;
    let tooLong: number | undefined;
    const fixture = () =>
      `fixture: ${FILE_COUNT} changed files, ${args.join(' ')}, start ${calibration ? `bound ${calibration.boundMs} ms ` +
        `(first count C=${calibration.countMs} ms, sync estimate S=${calibration.syncMs} ms)` : 'not calibrated'}; ` +
      `attempts ${attempts.map(a => `[bound ${a.boundMs} ms: pending ${String(a.pending)}, timedOut ` +
        `${String(a.timedOut)}, fresh ${String(a.fresh)}]`).join(' ') || 'none'}`;

    for (let n = 1; n <= CUT_ATTEMPTS; n++) {
      editAll(n);
      if (n === 1) {
        calibration = await calibrateBound(dir, indexAllMs);
        bound = calibration.boundMs;
      }
      const pre = await runCli(['checkpoint', dir, '--json']);
      const preCp = stdoutCheckpoint(pre);
      expect(preCp?.pending, `attempt ${n} does not start with every file pending: plain checkpoint stdout ` +
        `${JSON.stringify(pre.stdout)}; ${fixture()}`).toBe(FILE_COUNT);

      const run = await runCli(args, { ...extra, CODEGRAPH_FRESH_TIMEOUT_MS: String(bound) });
      const cp = readCp(run);
      if (!cp) {
        throw new Error(`attempt ${n} printed no checkpoint (status ${run.status}, signal ${run.signal}, ` +
          `stdout ${JSON.stringify(run.stdout.slice(0, 200))}, ${describeTimes(run)}); ${fixture()}`);
      }
      attempts.push({ boundMs: bound, pending: cp.pending, timedOut: cp.timedOut, fresh: cp.fresh });
      const pending = cp.pending;
      if (typeof pending !== 'number' || pending >= FILE_COUNT) {
        tooShort = bound;
        bound = tooLong !== undefined ? Math.round(Math.sqrt(bound * tooLong)) : bound * 2;
      } else if (cp.timedOut !== true || pending < FILE_COUNT * CUT_MIN_LEFT) {
        tooLong = bound;
        bound = tooShort !== undefined ? Math.round(Math.sqrt(bound * tooShort)) : Math.max(1, Math.round(bound / 2));
      } else {
        return { run, cp, attempts, calibration: calibration! };
      }
    }
    throw new Error(`no attempt cut a running sync with at least ${FILE_COUNT * CUT_MIN_LEFT} files left. ` +
      `pending ${FILE_COUNT} = no sync started before the bound; pending near 0 = the sync finished or nearly. ` +
      fixture());
  }

  /**
   * The answer, the checkpoint and the Note arrived before exit, and the checkpoint and the Note at
   * least ORDER_GAP_MS before it: the CLI printed them and then waited for the settle. With at least
   * FILE_COUNT * CUT_MIN_LEFT files still in flight, that settle takes far longer than ORDER_GAP_MS.
   *
   * At 4151dd6a (before the fix) the CLI destroys the writer at once, cutting the sync, and exits right
   * after its output, so the gap assertions fail there on their own; that version also prints no Note
   * line for --fresh, so the Note assertions fail first.
   */
  function expectPrintedBeforeSettle(run: CliRun, checkpointAt: number, cut: Cut): void {
    const times = `${describeTimes(run)}; attempts used ${cut.attempts.length}`;
    const notes = run.stderr.filter(l => l.text.startsWith('Note:'));
    expect.soft(notes, `one Note line; ${times}`).toHaveLength(1);
    expect(run.stdoutAt, `stdout answer before exit; ${times}`).toBeGreaterThanOrEqual(0);
    expect(run.stdoutAt, `stdout answer before exit; ${times}`).toBeLessThanOrEqual(run.exitAt);
    expect(checkpointAt, `checkpoint at least ${ORDER_GAP_MS} ms before exit; ${times}`)
      .toBeLessThanOrEqual(run.exitAt - ORDER_GAP_MS);
    expect(notes[0]?.at ?? Infinity, `Note at least ${ORDER_GAP_MS} ms before exit; ${times}`)
      .toBeLessThanOrEqual(run.exitAt - ORDER_GAP_MS);
  }

  // Over 5 s: up to CUT_ATTEMPTS CLI runs each over a FILE_COUNT-file edit, the accepted one waiting out
  // the sync, then a second CLI run, on a loaded machine.
  it('G1 query --fresh that times out prints first, then lets its sync finish: a plain checkpoint after it is fresh and the index is intact', async () => {
    const cut = await cutRun(['query', 'freshlyAdded0', '-p', dir, '--fresh', '--json'], {}, stderrCheckpoint);
    const r = cut.run;
    const cpLine = checkpointLines(r)[0];
    expect(r.signal).toBeNull();
    expect(cut.cp.fresh).toBe(false);
    expectPrintedBeforeSettle(r, cpLine.at, cut);
    expect(r.status).toBe(3);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    // Soft, so a run that fails here still reports the post-run state below.
    expect.soft(r.stderr.map(l => l.text).filter(l => !l.startsWith(CHECKPOINT_PREFIX) && !l.startsWith('Note:')))
      .toEqual([]);

    const after = await runCli(['checkpoint', dir, '--json']);
    const cp2 = stdoutCheckpoint(after);
    expect(cp2?.pending, `plain checkpoint after; attempts used ${cut.attempts.length}`).toBe(0);
    expect(after.status).toBe(0);
    expect(integrityCheck(dir)).toBe('ok');
  }, 600_000);

  // Over 5 s: up to CUT_ATTEMPTS CLI runs each over a FILE_COUNT-file edit, then a second CLI run syncing
  // up to FILE_COUNT files, on a loaded machine.
  //
  // No ordering-against-exit assertion here: with a settle cap of 0 the CLI exits right after its
  // output, and whether the parent sees that output or the exit first is a race.
  it('G2 query --fresh with a settle cap of 0 says the sync is still running; the next --fresh checkpoint catches up and the index is intact', async () => {
    const cut = await cutRun(['query', 'freshlyAdded0', '-p', dir, '--fresh', '--json'],
      { CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS: '0' }, stderrCheckpoint);
    const r = cut.run;
    expect(r.signal).toBeNull();
    expect(cut.cp.fresh).toBe(false);
    expect(r.status).toBe(3);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    // Soft, so a run that fails here still reports the post-run state below.
    const lines = r.stderr.map(l => l.text);
    expect.soft(lines.filter(l => /still running/i.test(l)), `attempts used ${cut.attempts.length}`).toHaveLength(1);
    expect.soft(lines.filter(l => !l.startsWith(CHECKPOINT_PREFIX) && !l.startsWith('Note:') && !/still running/i.test(l)))
      .toEqual([]);

    const after = await runCli(['checkpoint', dir, '--fresh', '--json']);
    const cp2 = stdoutCheckpoint(after);
    expect(cp2?.pending, `--fresh checkpoint after; attempts used ${cut.attempts.length}`).toBe(0);
    expect(after.status).toBe(0);
    expect(integrityCheck(dir)).toBe('ok');
  }, 600_000);

  // Over 5 s: up to CUT_ATTEMPTS CLI runs each over a FILE_COUNT-file edit, the accepted one waiting out
  // the sync, then a second CLI run, on a loaded machine.
  it('G3 checkpoint --fresh --json that times out prints its JSON and a Note first, then lets its sync finish: a plain checkpoint after it is fresh and the index is intact', async () => {
    const cut = await cutRun(['checkpoint', dir, '--fresh', '--json'], {}, stdoutCheckpoint);
    const r = cut.run;
    expect(r.signal).toBeNull();
    expect(cut.cp.fresh).toBe(false);
    // The checkpoint IS the stdout answer here, so its arrival is stdoutAt.
    expectPrintedBeforeSettle(r, r.stdoutAt, cut);
    expect(r.status).toBe(3);
    // Soft, so a run that fails here still reports the post-run state below.
    expect.soft(r.stderr.map(l => l.text).filter(l => !l.startsWith('Note:'))).toEqual([]);

    const after = await runCli(['checkpoint', dir, '--json']);
    const cp2 = stdoutCheckpoint(after);
    expect(cp2?.pending, `plain checkpoint after; attempts used ${cut.attempts.length}`).toBe(0);
    expect(after.status).toBe(0);
    expect(integrityCheck(dir)).toBe('ok');
  }, 600_000);
});
