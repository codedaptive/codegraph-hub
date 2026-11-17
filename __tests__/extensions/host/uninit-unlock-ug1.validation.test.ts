/**
 * Uninit gate UG1:
 *
 *   UG1   uninit --force under a running server and builder: the index is deleted, and neither process holds a file
 *         under the project's `.codegraph` afterwards (lsof).
 *
 * It runs in the validation group. The other uninit and unlock gates are in `uninit-unlock.validation.test.ts`, and the
 * helpers in `uninit-unlock.harness.ts` and `machine-server.harness.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../src/directory';
import {
  Fixtures,
  LSOF_AVAILABLE,
  McpSession,
  builderPidOf,
  isAlive,
  serverPidOf,
  stopIfCodegraph,
  waitUntil,
} from './machine-server.harness';
import {
  BUILDER_APPEAR_MS,
  exitProblems,
  normalise,
  openUnder,
  plainProject,
  runCli,
  successLine,
  tail,
} from './uninit-unlock.harness';

/** The period of the lsof poll. lsof is a subprocess, so the poll does not run at the 25 ms default. */
const LSOF_POLL_MS = 500;
/** The explore tool's name, as the server lists it. Its answer is not judged here: the call opens the index in the server. */
const EXPLORE = 'codegraph_explore';

/** The pids of `pids` (nulls skipped) that hold a codegraph.db under `dir` open. */
function dbHolders(pids: Array<number | null>, dir: string): number[] {
  return pids.filter(
    (pid): pid is number => pid !== null && openUnder(pid, dir).some((name) => path.basename(name) === 'codegraph.db'),
  );
}

describe('uninit with a machine server running (UG1)', () => {
  const fx = new Fixtures();
  /** The directory every CLI run is started in. */
  let launchDir = '';
  /** The state dir the server runs in. */
  let stateDir = '';
  /** The project UG1 deletes under the running server. */
  let U1 = '';
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

  // Setup for UG1, not a gate: one small index built in-process before any server exists, then a serve --mcp session
  // whose builder and server are waited on.
  beforeAll(async () => {
    const dir = fx.tempRoot();
    // A session launched outside git answers only for its launch directory and what is below it, so the session starts
    // in the directory that holds the project, and the project is in its scope.
    launchDir = dir;
    stateDir = path.join(dir, 'state');
    // A one-file git repository: codegraph indexes only git worktrees (R-46), and `init` refuses a folder in none (S-70).
    U1 = fx.makeRepo(plainProject(path.join(dir, 'u1'), 'ug1Base'), {});
    fx.index(U1, stateDir);

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
});
