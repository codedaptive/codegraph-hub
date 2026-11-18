import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { DatabaseConnection, getDatabasePath } from '../../../src/db';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

describe('holder ownership and background jobs', { timeout: 90_000 }, () => {
  let base: string;
  let root: string;
  let holders: HolderSet;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-holder-extra-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'first.ts']);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
  });

  afterEach(async () => {
    await holders?.closeAll();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function setup(queue: JobQueue, runJob: ReturnType<typeof inProcessJobRunner>['runJob']): void {
    holders = new HolderSet({
      queue, fences: new RebuildFences(queue, () => undefined), onFreshness: () => undefined,
      log: () => undefined, watchOptions: () => ({ debounceMs: 100 }),
      openWaitMs: 10_000, recoverWaitMs: 10_000, ownRetryMs: 50, pollMs: 100,
      ...{ runJob },
    });
  }

  it('runs recovery of an interrupted bulk load through a recover job', async () => {
    const db = DatabaseConnection.open(getDatabasePath(root));
    db.beginBulkRefLoad();
    db.close();
    const runner = inProcessJobRunner();
    setup(new JobQueue({ loadAverage: () => 0 }), runner.runJob);
    expect(await holders.hold(root)).toMatchObject({ kind: 'held' });
    await holders.caughtUp(root);
    expect(runner.specs).toContainEqual(expect.objectContaining({ kind: 'recover', root, writerPid: process.pid }));
  });

  it('runs a watcher-triggered sync through a watch-sync job', async () => {
    vi.stubEnv('CODEGRAPH_NO_WATCH', '');
    let finish: () => void = () => undefined;
    const watchJob = new Promise<void>((resolve) => { finish = resolve; });
    const queue = new JobQueue({
      loadAverage: () => 0,
      onEvent: (event) => { if (event.edge === 'end' && event.kind === 'watch-sync') finish(); },
    });
    const runner = inProcessJobRunner();
    setup(queue, runner.runJob);
    expect(await holders.hold(root)).toMatchObject({ kind: 'held' });
    await holders.caughtUp(root);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 22;\n');
    await watchJob;
    expect(runner.specs).toContainEqual(expect.objectContaining({ kind: 'watch-sync', root, writerPid: process.pid }));
  });
});
