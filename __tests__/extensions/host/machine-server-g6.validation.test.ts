/**
 * Machine-server gate G6: a call inside the anchor is built for itself and never
 * answered from an index outside it. It runs in the validation group; the other
 * gates are in `machine-server.gate.test.ts` and the helpers in `machine-server.harness.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EXPLORE, Fixtures, answers, excerpt, sleep } from './machine-server.harness';

describe('machine server gates (serve --mcp over stdio, throwaway repos)', () => {
  const fx = new Fixtures();
  afterEach(() => fx.teardown(), 180_000);

  // G6: the index a call is answered from must itself be inside the anchor. A
  // projectPath inside the repository passes the path check, but index discovery
  // walks UP from it: with no index of its own, the repository would be answered
  // from `outer/.codegraph`, a graph of a git repository holding the nested
  // repository and unrelated code (init indexes only a git root). The nested
  // repository is its own git root, so the outer index is
  // another project's and is never selected for it: the builder cold-builds the
  // repository's own index, the first call answers the building note naming the
  // repository, a later call answers from the repository's own index, and the
  // outside code never comes back in any answer.
  it('G6: a call inside the anchor is built for itself, never answered from an index outside it', async () => {
    // Waits for a CLI index run, a `serve --mcp` cold start, and a cold build of the repository
    // by the builder (polled for up to 180 s), with tool calls around it.
    const root = fx.tempRoot();
    const stateDir = path.join(root, 'state');
    const outer = path.join(root, 'outer');
    fx.makeRepo(outer, {
      'src/outside.ts': 'export function g6OutsideSymbol(): string {\n  return "g6-outside-body-marker";\n}\n',
    });
    const repo = fx.makeRepo(path.join(outer, 'repo'), {
      'src/inside.ts': 'export function g6InsideSymbol(): string {\n  return "g6-inside-body-marker";\n}\n',
    });
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
    const deadline = Date.now() + 180_000;
    let last = abs;
    let answered = answers(abs, 'g6InsideSymbol', 'g6-inside-body-marker');
    while (!answered && Date.now() < deadline) {
      await sleep(500);
      last = await session.tool(EXPLORE, { query: 'g6InsideSymbol', projectPath: '.' });
      seen.push(last.text);
      answered = answers(last, 'g6InsideSymbol', 'g6-inside-body-marker');
    }
    if (!answered) problems.push(`(b) no call answered from the repository's own index within 180 s: ${excerpt(last)}`);
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
  }, 900_000);
});
