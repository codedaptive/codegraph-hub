/**
 * Pinned-open gates PO1-PO4: the machine server opens every pinned project that has an index when it starts
 * (PO1), skips a pinned root it cannot open with a line in `<state>/server.log` and still starts (PO2), opens a
 * project pinned while it runs on its housekeeping pass (PO3), and lets the idle release close a project it opened
 * for a pin once the pin is removed (PO4). Every open happens with no tool call.
 *
 * Each gate drives the built CLI's `serve --mcp` over stdio, as an agent host does, against throwaway git
 * repositories, with CODEGRAPH_STATE_DIR set per test. What a gate observes from outside: `<state>/builder.pid` and
 * `builder.log` (the builder's job lines), `writer.pid` under each root's `.codegraph/` (the builder that holds a
 * root names itself there), the codegraph.db files the server holds open (lsof), `<state>/server.log`, and whether
 * pids are alive. The helpers are in `machine-server.harness.ts`.
 *
 * A gate waits on a condition, bounded, then evaluates each step and collects the failing ones, so one run reports
 * every problem at once. Each entry names its step by number.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  Fixtures,
  LSOF_AVAILABLE,
  builderLogLines,
  builderPidOf,
  isAlive,
  lockFileHolders,
  openCodegraphDbs,
  serverPidOf,
  stopIfCodegraph,
  stopProcess,
  waitUntil,
} from './machine-server.harness';

/** How long a gate waits for the server, the builder and the lock files to reach the state it expects. */
const OPEN_WAIT_MS = 60_000;
/** The poll interval of every wait that runs lsof. lsof is a subprocess, so the poll must not run faster. */
const LSOF_POLL_MS = 250;
/** The housekeeping interval for the gates that pin or unpin while the server runs. */
const FAST_HOUSEKEEPING_MS = '500';
/** The project idle timeout for the unpin gate. */
const SHORT_IDLE_MS = '1500';

/** The `job start catch-up <root>` lines of builder.log, each with its line index. */
function catchUpStarts(stateDir: string): Array<{ index: number; root: string }> {
  const starts: Array<{ index: number; root: string }> = [];
  builderLogLines(stateDir).forEach((line, index) => {
    const m = /^\S+ job start catch-up (.+)$/.exec(line);
    if (m !== null) starts.push({ index, root: m[1]! });
  });
  return starts;
}

/** True when a catch-up job for `root` started at or after line `fromIndex` of builder.log. */
function catchUpSince(stateDir: string, root: string, fromIndex: number): boolean {
  return catchUpStarts(stateDir).some((job) => job.index >= fromIndex && job.root === root);
}

/** The pid `root`'s writer.pid names, or null when it names none. */
function writerHolderOf(root: string): number | null {
  return lockFileHolders(root).find((holder) => holder.file === 'writer.pid')?.pid ?? null;
}

/**
 * True when the builder that builder.pid names is alive and is the holder of `root`'s writer.pid. The builder
 * holds a root (watcher, open database, writer.pid) only once the server asks it to; nothing else takes writer.pid
 * for it.
 */
function heldByLiveBuilder(stateDir: string, root: string): boolean {
  const builder = builderPidOf(stateDir);
  return builder !== null && isAlive(builder) && writerHolderOf(root) === builder;
}

/** The codegraph.db of `root`. */
function dbOf(root: string): string {
  return path.join(root, '.codegraph', 'codegraph.db');
}

/**
 * How many rows of the nodes table of `dbFile` are named `name`, read through a read-only handle that this closes
 * before it returns, so a poll never holds the file open. 0 when the file is missing or cannot be read at that moment
 * (the builder may be writing it).
 */
function indexedNodeCount(dbFile: string, name: string): number {
  if (!fs.existsSync(dbFile)) return 0;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE name = ?').get(name) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

/** True when the server (server.pid) holds `root`'s codegraph.db open. Callers check LSOF_AVAILABLE first. */
function serverHoldsDb(stateDir: string, root: string): boolean {
  const server = serverPidOf(stateDir);
  return server !== null && openCodegraphDbs(server).includes(dbOf(root));
}

/** The codegraph.db files the server holds open, for a failure message. */
function serverOpenDbsText(stateDir: string): string {
  const server = serverPidOf(stateDir);
  if (server === null) return 'no server.pid';
  return `server ${server} holds open [${openCodegraphDbs(server).join(', ') || 'none'}]`;
}

/** The lines of `<state>/server.log` that name `root` and say it was skipped. */
function skipLines(stateDir: string, root: string): string[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(stateDir, 'server.log'), 'utf8');
  } catch {
    /* not written yet */
  }
  return text.split('\n').filter((line) => line.includes(root) && /skipped/i.test(line));
}

describe('pinned projects are opened by the machine server (PO1-PO4)', () => {
  const fx = new Fixtures();
  /** Builder pids the gates recorded. Teardown stops the server first, which takes its builder down; these are a backstop. */
  const builderPids: number[] = [];
  afterEach(async () => {
    await fx.teardown();
    for (const pid of builderPids.splice(0)) await stopIfCodegraph(pid);
  }, 60_000);

  // PO1: a pinned project with an index is opened at start. R is pinned and indexed. A first session starts the
  // server and its builder, then both are stopped. A second session starts and makes no tool call. Within
  // OPEN_WAIT_MS the builder holds R (writer.pid names the new builder), a catch-up job for R starts on the builder
  // after the restart, and the new server holds R's codegraph.db open. Then, still with no tool call, a source file
  // written into R is indexed within OPEN_WAIT_MS: a root that is held and open but not kept current passes the first
  // three steps and fails this one.
  it('PO1: after a restart, a pinned project with an index is held and open, and kept current, with no tool call', async () => {
    // Over 5 s by design: a CLI index and a pin, two `serve --mcp` starts (each loads the wasm runtime), the stop of
    // the first server and its builder, the wait of up to 60 s for the new server's open and the builder's hold, and
    // the wait of up to 60 s for a file written into R to be indexed.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/po1.ts': 'export function po1PinnedSymbol(): string {\n  return "po1-body-marker";\n}\n',
    });
    fx.index(repo, stateDir);
    fx.pin(repo, stateDir);

    // The first start: its server and builder come up, then both are stopped.
    const sessionA = fx.session({ cwd: repo, stateDir });
    await sessionA.initialize();
    await waitUntil(() => builderPidOf(stateDir) !== null, 30_000, 100);
    const oldServer = serverPidOf(stateDir);
    const oldBuilder = builderPidOf(stateDir);
    expect(oldServer !== null && oldBuilder !== null, 'PO1 setup: the first start wrote server.pid and builder.pid').toBe(true);
    builderPids.push(oldBuilder!);
    await sessionA.end();
    await stopProcess(oldServer!);
    const stopped = await waitUntil(() => !isAlive(oldServer!) && !isAlive(oldBuilder!), 30_000, 100);
    expect(stopped, 'PO1 setup: the old server and the old builder are both dead before the restart').toBe(true);

    // The second start: initialize, then no tool call. The open must come from the server's own start.
    const logBaseline = builderLogLines(stateDir).length;
    const sessionB = fx.session({ cwd: repo, stateDir });
    await sessionB.initialize();
    const newHeld = (): boolean => builderPidOf(stateDir) !== oldBuilder && heldByLiveBuilder(stateDir, repo);
    const newOpen = (): boolean => !LSOF_AVAILABLE || (serverPidOf(stateDir) !== oldServer && serverHoldsDb(stateDir, repo));
    await waitUntil(() => newHeld() && catchUpSince(stateDir, repo, logBaseline) && newOpen(), OPEN_WAIT_MS, LSOF_POLL_MS);
    const newBuilder = builderPidOf(stateDir);
    if (newBuilder !== null) builderPids.push(newBuilder);

    // (4) Kept current, not only open: a source file written into R after the restart, with still no tool call, is
    // indexed. The builder holds R with its watcher, so the file's event starts a sync job on the builder's queue. The
    // wait is OPEN_WAIT_MS because the event, the watcher's debounce and the sync job all run before the row exists, and
    // a machine under load can take tens of seconds for that. The file is not committed: discovery excludes only
    // ignored files, so an untracked source file is indexed too.
    const addedSymbol = 'po1AddedAfterRestartSymbol';
    fs.writeFileSync(path.join(repo, 'src', 'po1-added.ts'), `export function ${addedSymbol}(): string {\n  return "po1-added-body-marker";\n}\n`);
    await waitUntil(() => indexedNodeCount(dbOf(repo), addedSymbol) > 0, OPEN_WAIT_MS, LSOF_POLL_MS);

    const problems: string[] = [];
    if (!newHeld()) {
      problems.push(
        `(1) nothing holds R with no tool call after the restart: writer.pid names ${writerHolderOf(repo) ?? 'no pid'}, ` +
          `builder.pid names ${newBuilder ?? 'no pid'} (the old builder was ${oldBuilder})`,
      );
    }
    if (!catchUpSince(stateDir, repo, logBaseline)) {
      problems.push('(2) builder.log has no "job start catch-up" line for R written after the restart');
    }
    if (LSOF_AVAILABLE && !newOpen()) {
      problems.push(`(3) the server after the restart does not hold R's codegraph.db open: ${serverOpenDbsText(stateDir)}; expected ${dbOf(repo)}`);
    }
    if (indexedNodeCount(dbOf(repo), addedSymbol) === 0) {
      problems.push(`(4) R's index does not hold ${addedSymbol} within ${OPEN_WAIT_MS} ms of a source file written into R with no tool call`);
    }
    // Each entry starts with its step number: (1) R held by the new builder, (2) a catch-up job for R started after the
    // restart, (3) the new server holds R's codegraph.db open, (4) the source file written into R is indexed. Empty means
    // all four held within the bounded waits.
    expect(
      problems,
      `PO1 entries are the failing steps, each named by its number; empty means that after the restart, with no tool call, R was held, ` +
        `a catch-up job for R started, R's codegraph.db was open, and a source file written into R was indexed within ${OPEN_WAIT_MS} ms`,
    ).toEqual([]);
  }, 300_000);

  // PO2: a pinned root the server cannot open is skipped, and the rest still opens. D was indexed and pinned, then its
  // directory was deleted. E was pinned with no index. R is pinned and indexed. The server starts and answers
  // initialize. With no tool call, R is held and open; server.log has a line naming D's root with "skipped" and one
  // naming E's root; E gets no .codegraph/ directory (no cold build starts for it).
  it('PO2: a pinned root whose directory is gone, or that has no index, is skipped with a server.log line, and the server still starts', async () => {
    // Over 5 s by design: three CLI index and pin runs, a `serve --mcp` start, and the wait of up to 60 s for R's hold
    // and open and for the two skip lines the server writes as it starts.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo-r'), {
      'src/r.ts': 'export function po2RootSymbol(): string {\n  return "po2-r-body-marker";\n}\n',
    });
    const gone = fx.makeRepo(path.join(root, 'repo-d'), { 'src/d.ts': 'export const po2Gone = 1;\n' });
    const bare = fx.makeRepo(path.join(root, 'repo-e'), { 'src/e.ts': 'export const po2Bare = 1;\n' });
    fx.index(repo, stateDir);
    fx.index(gone, stateDir);
    fx.pin(gone, stateDir);
    fx.pin(repo, stateDir);
    fx.pin(bare, stateDir);
    // D's directory goes after its pin: a pin needs the directory to exist, and a pinned root whose directory is gone is
    // the case this gate covers.
    fs.rmSync(gone, { recursive: true, force: true });
    expect(fs.existsSync(path.join(bare, '.codegraph')), 'PO2 setup: the unindexed root E has no index after its pin').toBe(false);

    const session = fx.session({ cwd: repo, stateDir });
    await session.initialize();
    await waitUntil(
      () =>
        heldByLiveBuilder(stateDir, repo) &&
        (!LSOF_AVAILABLE || serverHoldsDb(stateDir, repo)) &&
        skipLines(stateDir, gone).length > 0 &&
        skipLines(stateDir, bare).length > 0,
      OPEN_WAIT_MS,
      LSOF_POLL_MS,
    );
    const builder = builderPidOf(stateDir);
    if (builder !== null) builderPids.push(builder);

    const problems: string[] = [];
    if (!heldByLiveBuilder(stateDir, repo)) {
      problems.push(`(1) R is not held by the builder with no tool call: writer.pid names ${writerHolderOf(repo) ?? 'no pid'}, builder.pid names ${builderPidOf(stateDir) ?? 'no pid'}`);
    }
    if (LSOF_AVAILABLE && !serverHoldsDb(stateDir, repo)) {
      problems.push(`(2) the server does not hold R's codegraph.db open with no tool call: ${serverOpenDbsText(stateDir)}`);
    }
    if (skipLines(stateDir, gone).length === 0) {
      problems.push(`(3) server.log has no line naming the gone root ${gone} with "skipped"`);
    }
    if (skipLines(stateDir, bare).length === 0) {
      problems.push(`(4) server.log has no line naming the unindexed root ${bare} with "skipped"`);
    }
    if (fs.existsSync(path.join(bare, '.codegraph'))) {
      problems.push(`(5) the unindexed root ${bare} now has a .codegraph/ directory: the server cold-built it`);
    }
    // Each entry starts with its step number: (1) R held, (2) R's database open in the server, (3) a skip line for the
    // gone root D, (4) a skip line for the unindexed root E, (5) E still has no .codegraph/. Empty means every step held.
    expect(problems, 'PO2 entries are the failing steps, each named by its number; empty means R is held and open, both skipped roots are logged, and E was not built').toEqual([]);
  }, 300_000);

  // PO3: a project pinned while the server runs is picked up on the housekeeping pass. The server starts with nothing
  // pinned and a housekeeping pass every 500 ms. Then R is indexed and pinned with the CLI. Within OPEN_WAIT_MS, with no
  // tool call, the builder holds R and the server holds R's codegraph.db open.
  it('PO3: a project pinned after the server started is held and open with no tool call', async () => {
    // Over 5 s by design: a `serve --mcp` start, a CLI index and pin run while the server is up, and the wait of up to
    // 60 s for the housekeeping pass to read the new pin and for the builder to hold the project and the server to open it.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const anchor = fx.makeRepo(path.join(root, 'anchor'), { 'src/anchor.ts': 'export const po3Anchor = 1;\n' });
    const repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/po3.ts': 'export function po3PinnedLaterSymbol(): string {\n  return "po3-body-marker";\n}\n',
    });
    const session = fx.session({ cwd: anchor, stateDir, env: { CODEGRAPH_HOUSEKEEPING_INTERVAL_MS: FAST_HOUSEKEEPING_MS } });
    await session.initialize();

    fx.index(repo, stateDir);
    expect(heldByLiveBuilder(stateDir, repo), 'PO3 setup: nothing holds R before its pin').toBe(false);
    fx.pin(repo, stateDir);

    await waitUntil(() => heldByLiveBuilder(stateDir, repo) && (!LSOF_AVAILABLE || serverHoldsDb(stateDir, repo)), OPEN_WAIT_MS, LSOF_POLL_MS);
    const builder = builderPidOf(stateDir);
    if (builder !== null) builderPids.push(builder);

    const problems: string[] = [];
    if (!heldByLiveBuilder(stateDir, repo)) {
      problems.push(
        `(1) the builder does not hold R within ${OPEN_WAIT_MS} ms of its pin, with no tool call: ` +
          `writer.pid names ${writerHolderOf(repo) ?? 'no pid'}, builder.pid names ${builder ?? 'no pid'}`,
      );
    }
    if (LSOF_AVAILABLE && !serverHoldsDb(stateDir, repo)) {
      problems.push(`(2) the server does not hold R's codegraph.db open within ${OPEN_WAIT_MS} ms of its pin, with no tool call: ${serverOpenDbsText(stateDir)}`);
    }
    // Each entry starts with its step number: (1) the builder holds R, (2) the server holds R's codegraph.db open.
    expect(problems, 'PO3 entries are the failing steps, each named by its number; empty means R was held and open after its pin with no tool call').toEqual([]);
  }, 300_000);

  // PO4: unpinning releases a project the server opened at start. R is pinned and indexed before the start, and the
  // server holds it open with no tool call. After `project unpin R` (idle timeout 1500 ms, housekeeping every 500 ms)
  // the server closes R's codegraph.db and the builder lets go of writer.pid within OPEN_WAIT_MS.
  it('PO4: unpinning a project the server opened at start lets the idle release close it', async () => {
    // Over 5 s by design: a CLI index and a pin, a `serve --mcp` start, the wait for the builder's hold and the server's
    // open, then the unpin and a poll of lsof for the idle release (a 1500 ms idle timeout, a housekeeping pass every 500 ms).
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo'), {
      'src/po4.ts': 'export function po4UnpinnedSymbol(): string {\n  return "po4-body-marker";\n}\n',
    });
    fx.index(repo, stateDir);
    fx.pin(repo, stateDir);

    const session = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_HOUSEKEEPING_INTERVAL_MS: FAST_HOUSEKEEPING_MS, CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: SHORT_IDLE_MS },
    });
    await session.initialize();
    await waitUntil(() => heldByLiveBuilder(stateDir, repo) && (!LSOF_AVAILABLE || serverHoldsDb(stateDir, repo)), OPEN_WAIT_MS, LSOF_POLL_MS);
    const builder = builderPidOf(stateDir);
    if (builder !== null) builderPids.push(builder);
    const openBeforeUnpin = heldByLiveBuilder(stateDir, repo) && (!LSOF_AVAILABLE || serverHoldsDb(stateDir, repo));
    expect(
      openBeforeUnpin,
      `PO4 precondition: before the unpin, the builder holds R and the server has R open (writer.pid ${writerHolderOf(repo) ?? 'no pid'}, builder ${builder ?? 'no pid'}, ${serverOpenDbsText(stateDir)}); without it the unpin has nothing to release`,
    ).toBe(true);

    fx.unpin(repo, stateDir);
    await waitUntil(() => !heldByLiveBuilder(stateDir, repo) && (!LSOF_AVAILABLE || !serverHoldsDb(stateDir, repo)), OPEN_WAIT_MS, LSOF_POLL_MS);

    const problems: string[] = [];
    if (LSOF_AVAILABLE && serverHoldsDb(stateDir, repo)) {
      problems.push(`(1) the server still holds R's codegraph.db open ${OPEN_WAIT_MS} ms after the unpin (idle timeout ${SHORT_IDLE_MS} ms): ${serverOpenDbsText(stateDir)}`);
    }
    if (heldByLiveBuilder(stateDir, repo)) {
      problems.push(`(2) writer.pid still names the live builder ${builder} ${OPEN_WAIT_MS} ms after the unpin`);
    }
    // Each entry starts with its step number: (1) the server closed R's codegraph.db, (2) the builder released writer.pid.
    expect(problems, `PO4 entries are the failing steps, each named by its number; empty means the idle release closed R after the unpin within ${OPEN_WAIT_MS} ms`).toEqual([]);
  }, 300_000);
});
