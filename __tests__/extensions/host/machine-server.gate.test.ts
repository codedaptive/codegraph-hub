/**
 * Machine-server gates G1-G6: one server per state dir (G1, G5); a session
 * answers only for its own repository and worktrees, from indexes inside it
 * (G3, G6); a server outlives its clients past the daemon idle timers (G2); a server holds one database
 * open per worktree it has answered for (G4a); and the project idle timer
 * closes unpinned worktrees while a pinned one stays open, and a later call
 * reopens one (G4b).
 *
 * Each gate starts the built CLI's `serve --mcp` over stdio, as an agent host
 * does, against throwaway git repositories indexed with `codegraph init --yes`.
 * Every spawn sets CODEGRAPH_STATE_DIR to a temp directory and
 * CODEGRAPH_NO_UPDATE_CHECK=1. The gates assert only what is observable from
 * outside: the tool answers, the attach log lines (CODEGRAPH_MCP_LOG_ATTACH=1),
 * `<state>/server.pid`, whether a server pid is alive, and the databases a
 * server holds open (lsof).
 *
 * A gate collects every failing step before it asserts, so one run reports
 * all of its problems at once. The helpers are in `machine-server.harness.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  Fixtures,
  LSOF_AVAILABLE,
  MISSING_PROJECT_PATH_TEXT,
  answers,
  excerpt,
  isAlive,
  openCodegraphDbs,
  serverPidOf,
  sleep,
  waitUntil,
} from './machine-server.harness';

const EXPLORE = 'codegraph_explore';
const pad = (n: number): string => String(n).padStart(2, '0');

describe('machine server gates (serve --mcp over stdio, throwaway repos)', () => {
  const fx = new Fixtures();
  afterEach(() => fx.teardown(), 60_000);

  // G1: one state dir, one server. Two sessions in two unrelated repositories
  // each answer for their own repository, and both attach to the same server
  // pid, which is the pid in server.pid.
  it('G1: two sessions in unrelated repositories with one state dir share one server', async () => {
    // Over 5 s by design: two CLI index runs and two `serve --mcp` cold starts
    // (each node process loads the wasm runtime), then the attach-line waits.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repoA = fx.makeRepo(path.join(root, 'repo-a'), { 'src/a.ts': 'export function g1AlphaOnly(): string {\n  return "g1-alpha-body-marker";\n}\n' });
    const repoB = fx.makeRepo(path.join(root, 'repo-b'), { 'src/b.ts': 'export function g1BetaOnly(): string {\n  return "g1-beta-body-marker";\n}\n' });
    fx.index(repoA, stateDir);
    fx.index(repoB, stateDir);
    const sessionA = fx.session({ cwd: repoA, stateDir });
    const sessionB = fx.session({ cwd: repoB, stateDir });
    await sessionA.initialize();
    await sessionB.initialize();

    const problems: string[] = [];
    const ansA = await sessionA.tool(EXPLORE, { query: 'g1AlphaOnly', projectPath: repoA });
    const ansB = await sessionB.tool(EXPLORE, { query: 'g1BetaOnly', projectPath: repoB });
    if (!answers(ansA, 'g1AlphaOnly', 'g1-alpha-body-marker')) problems.push(`session A did not answer its own symbol: ${excerpt(ansA)}`);
    if (!answers(ansB, 'g1BetaOnly', 'g1-beta-body-marker')) problems.push(`session B did not answer its own symbol: ${excerpt(ansB)}`);

    const pidA = await sessionA.attachedPid();
    const pidB = await sessionB.attachedPid();
    if (pidA === null || pidB === null) {
      problems.push(`an attach line is missing (session A pid ${pidA}, session B pid ${pidB})`);
    } else if (pidA !== pidB) {
      problems.push(`the two sessions attached to different servers: session A pid ${pidA}, session B pid ${pidB}`);
    }

    const serverPid = serverPidOf(stateDir);
    if (serverPid === null) {
      problems.push(`no ${path.join(stateDir, 'server.pid')} naming a server pid`);
    } else if (pidA !== null && pidA !== serverPid) {
      problems.push(`the attach log names pid ${pidA} but server.pid names pid ${serverPid}`);
    }

    expect(problems, 'G1 problems (empty when both sessions answer and share one server)').toEqual([]);
  }, 150_000);

  // G2: the server outlives its last client. One session answers a call,
  // closes, and after at least 5 s the server it attached to is still running.
  // The two daemon idle env vars are set to the old short idle values (1500 ms)
  // to prove the server ignores them and outlives its last client.
  it('G2: a server outlives its last client past the idle timeouts', async () => {
    // Over 5 s by design: one CLI index run, a `serve --mcp` cold start, and
    // the 5 s wait the gate requires after the client closes.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/idle.ts': 'export function g2IdleOnly(): string {\n  return "g2-idle-body-marker";\n}\n' });
    fx.index(repo, stateDir);
    const session = fx.session({
      cwd: repo,
      stateDir,
      env: { CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1500', CODEGRAPH_DAEMON_MAX_IDLE_MS: '1500' },
    });
    await session.initialize();

    const ans = await session.tool(EXPLORE, { query: 'g2IdleOnly', projectPath: repo });
    expect(answers(ans, 'g2IdleOnly', 'g2-idle-body-marker'), `G2: the call before the close answers (${excerpt(ans)})`).toBe(true);
    const pid = await session.attachedPid();
    expect(pid, 'G2: the attach log names a server pid').not.toBeNull();

    await session.end(); // the host closes the client; the launcher exits
    await sleep(5_000);
    expect(
      isAlive(pid!),
      `G2: server pid ${pid} is no longer running 5 s after its only client closed (idle timeouts 1500 ms)`,
    ).toBe(true);
  }, 120_000);

  // G3: a session answers only for its own repository. Launched in worktree
  // W1 of repository R, with no projectPath it answers the missing-argument
  // text; with a projectPath in an unrelated repository it names W1's root in
  // its success answer; with a projectPath in sibling worktree W2 it answers
  // from W2's own index.
  it('G3: a session needs projectPath and answers only for its own repository and worktrees', async () => {
    // Over 5 s by design: three CLI index runs, a `serve --mcp` cold start and
    // three tool calls, each a cold read of an index.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/base.ts': 'export const g3Base = 1;\n' });
    const w1 = fx.addWorktree(repo, 'g3-w1', path.join(root, 'w1'));
    const w2 = fx.addWorktree(repo, 'g3-w2', path.join(root, 'w2'));
    fx.commitFiles(w2, { 'src/w2only.ts': 'export function g3W2OnlySymbol(): string {\n  return "g3-w2-body-marker";\n}\n' }, 'g3: symbol only in W2');
    const unrelated = fx.makeRepo(path.join(root, 'unrelated'), {
      'src/u.ts': 'export function g3UnrelatedSymbol(): string {\n  return "g3-unrelated-body-marker";\n}\n',
    });
    fx.index(w2, stateDir);
    fx.index(unrelated, stateDir);
    const session = fx.session({ cwd: w1, stateDir });
    await session.initialize();

    const problems: string[] = [];
    const a = await session.tool(EXPLORE, { query: 'g3W2OnlySymbol' });
    if (a.rpcError !== null || a.isError || a.text !== MISSING_PROJECT_PATH_TEXT) {
      problems.push(`(a) no projectPath should answer exactly the missing-argument text, not isError: ${excerpt(a)}`);
    }
    const b = await session.tool(EXPLORE, { query: 'g3UnrelatedSymbol', projectPath: unrelated });
    if (b.rpcError !== null || b.isError || !b.text.includes(w1)) {
      problems.push(`(b) a projectPath in an unrelated repository should answer, naming the session's root ${w1}: ${excerpt(b)}`);
    }
    if (b.text.includes('g3-unrelated-body-marker')) {
      problems.push(`(b) the unrelated repository's source came back through a session anchored elsewhere: ${excerpt(b)}`);
    }
    const c = await session.tool(EXPLORE, { query: 'g3W2OnlySymbol', projectPath: w2 });
    if (!answers(c, 'g3W2OnlySymbol', 'g3-w2-body-marker')) {
      problems.push(`(c) a projectPath in sibling worktree W2 should answer with its own symbol's source: ${excerpt(c)}`);
    }

    // Each entry starts with its step letter: (a) no projectPath gives the
    // missing-argument text, (b) an unrelated repository's projectPath names the
    // session's root, (c) sibling worktree W2's projectPath answers its symbol.
    expect(problems, 'G3: entries are the failing steps, each named by its letter; empty means every step held').toEqual([]);
  }, 150_000);

  // G6: the index a call is answered from must itself be inside the anchor. A
  // projectPath inside the repository passes the path check, but index discovery
  // walks UP from it: with no index of its own, the repository would be answered
  // from `outer/.codegraph`, a graph of the directory above it that also holds
  // unrelated code. The repository is its own git root, so the outer index is
  // another project's and is never selected for it: the builder cold-builds the
  // repository's own index, the first call answers the building note naming the
  // repository, a later call answers from the repository's own index, and the
  // outside code never comes back in any answer.
  it('G6: a call inside the anchor is built for itself, never answered from an index outside it', async () => {
    // Over 5 s by design: a CLI index run, a `serve --mcp` cold start, a cold build of the repository
    // by the builder (polled for up to 120 s on an overloaded machine) and the tool calls around it.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const outer = path.join(root, 'outer');
    const repo = fx.makeRepo(path.join(outer, 'repo'), {
      'src/inside.ts': 'export function g6InsideSymbol(): string {\n  return "g6-inside-body-marker";\n}\n',
    });
    fs.mkdirSync(path.join(outer, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(outer, 'src', 'outside.ts'),
      'export function g6OutsideSymbol(): string {\n  return "g6-outside-body-marker";\n}\n',
    );
    // The index of the directory above the repository; the repository has none.
    fx.index(outer, stateDir);
    const outerReal = fs.realpathSync(outer);
    expect(fs.existsSync(path.join(repo, '.codegraph')), 'G6 setup: the repository has no index of its own').toBe(false);
    expect(fs.existsSync(path.join(outerReal, '.codegraph')), 'G6 setup: the outer directory has an index').toBe(true);
    const session = fx.session({ cwd: repo, stateDir });
    await session.initialize();

    const problems: string[] = [];
    const building = `building the index for ${repo}`;
    const seen: string[] = [];
    // (a) The first call, on "." (the repository), queues the repository's own build and answers building.
    const first = await session.tool(EXPLORE, { query: 'g6InsideSymbol', projectPath: '.' });
    seen.push(first.text);
    if (first.rpcError !== null || first.isError) problems.push(`(a) projectPath ".": the building note, not an error: ${excerpt(first)}`);
    if (!first.text.includes(building)) {
      problems.push(`(a) projectPath ".": the first call should answer the building note naming ${repo}: ${excerpt(first)}`);
    }
    // The absolute spelling of the same repository: the build may already have finished, so it answers the
    // building note or, once built, its own index; never an error and never the outer index.
    const abs = await session.tool(EXPLORE, { query: 'g6InsideSymbol', projectPath: repo });
    seen.push(abs.text);
    if (abs.rpcError !== null || abs.isError) problems.push(`(a) projectPath ${repo}: not an error: ${excerpt(abs)}`);
    if (!abs.text.includes(building) && !answers(abs, 'g6InsideSymbol', 'g6-inside-body-marker')) {
      problems.push(`(a) projectPath ${repo}: should answer the building note or the repository's own source: ${excerpt(abs)}`);
    }

    // (b) A later call answers from the repository's own index within a bounded wait.
    const deadline = Date.now() + 120_000;
    let last = abs;
    let answered = answers(abs, 'g6InsideSymbol', 'g6-inside-body-marker');
    while (!answered && Date.now() < deadline) {
      await sleep(500);
      last = await session.tool(EXPLORE, { query: 'g6InsideSymbol', projectPath: '.' });
      seen.push(last.text);
      answered = answers(last, 'g6InsideSymbol', 'g6-inside-body-marker');
    }
    if (!answered) problems.push(`(b) no call answered from the repository's own index within 120 s: ${excerpt(last)}`);
    if (!fs.existsSync(path.join(repo, '.codegraph', 'codegraph.db'))) {
      problems.push(`(b) ${path.join(repo, '.codegraph', 'codegraph.db')} is missing: the repository has no index of its own`);
    }

    // (c) A query for a symbol only the outer directory holds gets none of its code from the repository's index.
    const c = await session.tool(EXPLORE, { query: 'g6OutsideSymbol', projectPath: '.' });
    seen.push(c.text);
    if (seen.some((text) => text.includes('g6-outside-body-marker'))) {
      problems.push(`(c) an answer carried the outer directory's source (${outerReal}): ${excerpt(c)}`);
    }

    // (a) the first call (relative projectPath) answers the building note for the repository, and the call on the
    // absolute path answers the building note or, if the build already finished, the repository's own source;
    // (b) a later call answers from the repository's own index; (c) no answer carries outer-only content.
    expect(problems, 'G6: entries are the failing steps, each named by its letter; empty means every step held').toEqual([]);
  }, 150_000);

  // G4a: one server, one open database per worktree. A session in the main
  // checkout of a repository with ten indexed linked worktrees, with the
  // project idle timer at 0 (never released), answers a call on each worktree.
  // Afterwards the server holds at least ten distinct codegraph.db files open.
  it.runIf(LSOF_AVAILABLE)('G4a: after a call on each of ten worktrees, the server holds ten databases open', async () => {
    // Over 5 s by design: eleven CLI index runs (the main checkout and ten
    // worktrees), a `serve --mcp` cold start, and ten tool calls, each reading
    // another worktree's index.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const files: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) {
      files[`src/wt${pad(i)}.ts`] = `export function g4WtSymbol${pad(i)}(): string {\n  return "g4-body-marker-${pad(i)}";\n}\n`;
    }
    const repo = fx.makeRepo(path.join(root, 'main'), files);
    const worktrees: string[] = [];
    for (let i = 1; i <= 10; i++) {
      worktrees.push(fx.addWorktree(repo, `g4-wt-${pad(i)}`, path.join(root, `wt-${pad(i)}`)));
    }
    fx.index(repo, stateDir);
    for (const wt of worktrees) fx.index(wt, stateDir);
    const session = fx.session({ cwd: repo, stateDir, env: { CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: '0' } });
    await session.initialize();

    const problems: string[] = [];
    for (let i = 0; i < worktrees.length; i++) {
      const symbol = `g4WtSymbol${pad(i + 1)}`;
      const ans = await session.tool(EXPLORE, { query: symbol, projectPath: worktrees[i]! });
      if (!answers(ans, symbol, `g4-body-marker-${pad(i + 1)}`)) problems.push(`worktree ${i + 1} did not answer with its own symbol's source: ${excerpt(ans)}`);
    }

    const pid = await session.attachedPid();
    if (pid === null) {
      problems.push('no attach line, so there is no server pid to count databases for');
    } else {
      const open = openCodegraphDbs(pid);
      if (open.length < 10) {
        problems.push(
          `(i) server pid ${pid} holds ${open.length} distinct codegraph.db files open after a call on each of the ten worktrees; expected at least 10`,
        );
      }
    }

    expect(problems, 'G4a problems (empty when every worktree answers and the server holds ten databases open)').toEqual([]);
  }, 300_000);

  // G4b: the project idle timer. One worktree is pinned; the others are not.
  // After a call on each worktree and a wait for the idle close, the pinned
  // worktree's database is still open and no other codegraph.db is. A later
  // call on an unpinned worktree answers its own worktree-only symbol, and its
  // database is open again.
  it.runIf(LSOF_AVAILABLE)('G4b: a pinned worktree stays open through the project idle timer, the others close, and a later call reopens one', async () => {
    // Over 5 s by design: eleven CLI index runs, a `project pin` CLI run, a
    // `serve --mcp` cold start, ten tool calls, and a poll of lsof that waits
    // for the 1500 ms project idle timer to close the unpinned databases.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const repo = fx.makeRepo(path.join(root, 'main'), { 'src/base.ts': 'export const g4bBase = 1;\n' });
    // Each worktree commits a symbol of its own, so a symbol answered from the
    // wrong worktree cannot pass.
    const worktrees: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const wt = fx.addWorktree(repo, `g4b-wt-${pad(i)}`, path.join(root, `wt-${pad(i)}`));
      fx.commitFiles(wt, { [`src/wt${pad(i)}.ts`]: `export function g4bWtOnly${pad(i)}(): string {\n  return "g4b-body-marker-${pad(i)}";\n}\n` }, `g4b: symbol only in worktree ${pad(i)}`);
      worktrees.push(wt);
    }
    fx.index(repo, stateDir);
    for (const wt of worktrees) fx.index(wt, stateDir);
    const pinned = worktrees[0]!;
    fx.pin(pinned, stateDir);
    const session = fx.session({ cwd: repo, stateDir, env: { CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS: '1500' } });
    await session.initialize();

    const problems: string[] = [];
    for (let i = 0; i < worktrees.length; i++) {
      const symbol = `g4bWtOnly${pad(i + 1)}`;
      const ans = await session.tool(EXPLORE, { query: symbol, projectPath: worktrees[i]! });
      if (!answers(ans, symbol, `g4b-body-marker-${pad(i + 1)}`)) problems.push(`worktree ${i + 1} did not answer with its own symbol's source: ${excerpt(ans)}`);
    }

    const pid = await session.attachedPid();
    expect(pid, 'G4b: the attach log names a server pid').not.toBeNull();
    const dbOf = (wt: string): string => path.join(wt, '.codegraph', 'codegraph.db');
    const pinnedDb = dbOf(pinned);
    const unpinnedDbs = worktrees.slice(1).map(dbOf);

    // Wait, polling lsof, until the idle close has released every unpinned
    // database. The deadline is far past the 1500 ms idle timeout.
    await waitUntil(() => {
      const open = openCodegraphDbs(pid!);
      return !unpinnedDbs.some((db) => open.includes(db));
    }, 20_000, 250);

    const open = openCodegraphDbs(pid!);
    if (!open.includes(pinnedDb)) {
      problems.push(`(1) the pinned worktree's database is not open: ${pinnedDb}`);
    }
    const stillOpen = unpinnedDbs.filter((db) => open.includes(db));
    if (stillOpen.length > 0) {
      problems.push(`(2) unpinned worktree databases still open when the poll ended (idle timeout 1500 ms): ${stillOpen.join(', ')}`);
    }
    const others = open.filter((db) => db !== pinnedDb && !unpinnedDbs.includes(db));
    if (others.length > 0) {
      problems.push(`(3) a codegraph.db that is neither the pinned worktree's nor an unpinned worktree's is open: ${others.join(', ')}`);
    }

    const later = await session.tool(EXPLORE, { query: 'g4bWtOnly02', projectPath: worktrees[1]! });
    if (!answers(later, 'g4bWtOnly02', 'g4b-body-marker-02')) {
      problems.push(`(4) a later call on unpinned worktree 2 did not answer with its own symbol's source: ${excerpt(later)}`);
    }
    const reopened = await waitUntil(() => openCodegraphDbs(pid!).includes(unpinnedDbs[0]!), 5_000, 100);
    if (!reopened) {
      problems.push(`(5) worktree 2's database is not open again after the later call: ${unpinnedDbs[0]}`);
    }

    // Each entry below starts with the number of the step it reports: (1) pinned
    // database open, (2) unpinned databases closed, (3) no other database open,
    // (4) a later call answers its symbol, (5) its database reopened. No entries
    // means every step held.
    expect(problems, 'G4b: entries are the failing steps, each named by its number; empty means every step held').toEqual([]);
  }, 300_000);

  // G5: two state dirs, two servers. Two sessions in the same repository with
  // two different state dirs run two different servers. Stopping the first by
  // the pid in its own server.pid leaves the second running and still answering.
  it('G5: two state dirs give two servers, and stopping one leaves the other answering', async () => {
    // Over 5 s by design: a CLI index run, two `serve --mcp` cold starts, and
    // the wait for the stopped server to exit.
    const root = fx.tempRoot();
    const stateOne = path.join(root, 'state-1');
    const stateTwo = path.join(root, 'state-2');
    const repo = fx.makeRepo(path.join(root, 'repo'), { 'src/shared.ts': 'export function g5SharedOnly(): string {\n  return "g5-shared-body-marker";\n}\n' });
    fx.index(repo, stateOne);
    const sessionOne = fx.session({ cwd: repo, stateDir: stateOne });
    const sessionTwo = fx.session({ cwd: repo, stateDir: stateTwo });
    await sessionOne.initialize();
    await sessionTwo.initialize();

    const problems: string[] = [];
    const ansOne = await sessionOne.tool(EXPLORE, { query: 'g5SharedOnly', projectPath: repo });
    const ansTwo = await sessionTwo.tool(EXPLORE, { query: 'g5SharedOnly', projectPath: repo });
    if (!answers(ansOne, 'g5SharedOnly', 'g5-shared-body-marker')) problems.push(`session one did not answer: ${excerpt(ansOne)}`);
    if (!answers(ansTwo, 'g5SharedOnly', 'g5-shared-body-marker')) problems.push(`session two did not answer: ${excerpt(ansTwo)}`);

    const attachOne = await sessionOne.attachedPid();
    const attachTwo = await sessionTwo.attachedPid();
    const serverOne = serverPidOf(stateOne);
    const serverTwo = serverPidOf(stateTwo);
    if (attachOne === null || attachTwo === null) {
      problems.push(`an attach line is missing (session one pid ${attachOne}, session two pid ${attachTwo})`);
    } else if (attachOne === attachTwo) {
      problems.push(`both sessions attached to pid ${attachOne}: one server serves two state dirs`);
    }
    if (serverOne === null || serverTwo === null) {
      problems.push(`server.pid missing a pid (state one ${serverOne}, state two ${serverTwo})`);
    } else if (serverOne === serverTwo) {
      problems.push(`server.pid names pid ${serverOne} in both state dirs`);
    }
    // The steps below stop one server, so they need two distinct servers first.
    expect(problems, 'G5 problems (two distinct servers, one per state dir, are needed before one can be stopped)').toEqual([]);

    process.kill(serverOne!, 'SIGTERM');
    const stopped = await waitUntil(() => !isAlive(serverOne!), 10_000);
    expect(stopped, `G5: server ${serverOne} (state one) exits on SIGTERM`).toBe(true);
    expect(isAlive(serverTwo!), `G5: server ${serverTwo} (state two) is still running after server ${serverOne} stopped`).toBe(true);

    const after = await sessionTwo.tool(EXPLORE, { query: 'g5SharedOnly', projectPath: repo });
    expect(answers(after, 'g5SharedOnly', 'g5-shared-body-marker'), `G5: session two still answers after server ${serverOne} stopped (${excerpt(after)})`).toBe(true);
  }, 150_000);
});
