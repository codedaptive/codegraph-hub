/**
 * R1-01: a port of upstream beebf1cc to ours.
 *
 * A sync refreshes the stat of a file whose bytes did not change (a fresh
 * checkout, a copied index, `touch`) by writing its new size and mtime with
 * `upsertFile`. Each of those writes commits on its own, and while a sync
 * defers WAL checkpoints a run of them can grow the WAL past the WAL valve's
 * caps when a reader pins its frames. So each stat-only refresh must give the
 * valve the same between-commits check the re-index loop gives it, and a
 * pending pause must resolve before the next refresh is written.
 *
 * Validated on macOS only (the dev machine). Each fixture is a one-line file in
 * a throwaway temp dir; nothing here indexes a team worktree. Each test takes
 * about 2 to 2.5 seconds on a loaded machine: under the 5-second line, though
 * not by a wide margin, so none needs a timing note yet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../../src/index';
import { WalCheckpointValve } from '../../../src/db/wal-valve';
import { QueryBuilder } from '../../../src/db/queries';

// Same `fs` harness as __tests__/sync-mtime-refresh.test.ts: a plain-object copy
// of `fs` shared by this file and every module it loads, so an fs spy would
// reach the engine's calls (an ESM namespace cannot be spied on). This file
// spies on WalCheckpointValve and QueryBuilder, not on fs.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

describe('sync checks the WAL valve around each stat-only refresh', () => {
  let testDir: string;
  let cg: CodeGraph;
  let filePath: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-mtime-review-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    filePath = path.join(testDir, 'src', 'index.ts');
    fs.writeFileSync(filePath, `export function hello() { return 'world'; }`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** Indexes two more files and returns the three tracked paths. */
  async function indexTwoMoreFiles(): Promise<string[]> {
    const extra = ['a', 'b'].map((n) => path.join(testDir, 'src', `${n}.ts`));
    for (const f of extra) fs.writeFileSync(f, `export const v = 1;`);
    await cg.sync();
    return [filePath, ...extra];
  }

  /** Gives each file a new mtime; the bytes stay as they are. */
  function touch(files: string[]): void {
    const later = new Date(Date.now() + 240_000);
    for (const f of files) fs.utimesSync(f, later, later);
  }

  it('checks the WAL valve after every stat-only refresh', async () => {
    const files = await indexTwoMoreFiles();
    const backpressure = vi
      .spyOn(WalCheckpointValve.prototype, 'backpressure')
      .mockReturnValue(null);

    // Three tracked files get a new mtime and keep their bytes.
    touch(files);

    const result = await cg.sync();
    expect(result.filesModified).toBe(0);
    expect(backpressure).toHaveBeenCalledTimes(3);

    // Nothing left to refresh: the next sync writes nothing and asks nothing.
    backpressure.mockClear();
    const next = await cg.sync();
    expect(next.filesModified).toBe(0);
    expect(backpressure).not.toHaveBeenCalled();
  });

  it('waits for a pending WAL pause before refreshing the next file', async () => {
    const files = await indexTwoMoreFiles();
    touch(files);

    // The first valve check pauses the sync until this test releases it.
    // Nothing waits on a clock: the race below settles on whichever comes
    // first, the sync reaching that pause or the sync finishing outright.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markPaused!: () => void;
    const paused = new Promise<'paused'>((resolve) => { markPaused = () => resolve('paused'); });
    const backpressure = vi
      .spyOn(WalCheckpointValve.prototype, 'backpressure')
      .mockImplementationOnce(() => {
        markPaused();
        return gate;
      })
      .mockReturnValue(null);
    const upsert = vi.spyOn(QueryBuilder.prototype, 'upsertFile');

    const sync = cg.sync();
    try {
      await Promise.race([paused, sync.then(() => 'finished' as const)]);
      // Paused: the first file's refresh is written and the next one is not.
      expect(backpressure).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      // Always let the sync run to its end, even when an assertion above failed,
      // and wait for it to settle so it can never outlive this test's teardown.
      release();
      await sync.catch(() => undefined);
    }

    const result = await sync;
    expect(result.filesModified).toBe(0);
    expect(backpressure).toHaveBeenCalledTimes(3);
  });
});
