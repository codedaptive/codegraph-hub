import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

describe('holder job runner', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;
  let holders: HolderSet;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-holder-jobs-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'first.ts']);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
    const cg = await CodeGraph.init(root);
    try { await cg.indexAll(); } finally { cg.close(); }
  });

  afterEach(async () => {
    await holders?.closeAll();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function setup(runJob: ReturnType<typeof inProcessJobRunner>['runJob'], watchOptions = () => ({})): void {
    const queue = new JobQueue({ loadAverage: () => 0 });
    holders = new HolderSet({
      queue, fences: new RebuildFences(() => undefined),
      onFreshness: () => undefined, log: () => undefined, watchOptions,
      openWaitMs: 10_000, recoverWaitMs: 1_000, ownRetryMs: 50, pollMs: 100,
      ...{ runJob },
    });
  }

  it('releases the builder writer lock when watcher options throw after open', async () => {
    const runner = inProcessJobRunner();
    setup(runner.runJob, () => { throw new Error('watch options failed'); });
    expect(await holders.hold(root)).toMatchObject({ kind: 'failed', error: 'watch options failed' });
    expect(readWriterLock(root)?.pid).not.toBe(process.pid);
  });

  it('releases the builder writer lock when the open job rejects', async () => {
    const runner = inProcessJobRunner();
    setup(async (id, spec, progress) => {
      if (spec.kind === 'open') throw new Error('open job failed');
      return runner.runJob(id, spec, progress);
    });
    expect(await holders.hold(root)).toMatchObject({ kind: 'failed', error: 'open job failed' });
    expect(readWriterLock(root)?.pid).not.toBe(process.pid);
  });

  it('runs open, catch-up and sync as jobs owned by the builder and indexes changes', async () => {
    vi.stubEnv('CODEGRAPH_NO_WATCH', '1');
    const runner = inProcessJobRunner();
    setup(runner.runJob);
    expect(await holders.hold(root)).toMatchObject({ kind: 'held' });
    await holders.caughtUp(root);
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 2;\n');
    execFileSync('git', ['-C', root, 'add', 'second.ts']);
    expect(await holders.sync(root)).toEqual({ filesChanged: 1 });
    expect(runner.specs.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['open', 'catch-up', 'sync']));
    for (const spec of runner.specs) {
      expect(spec).toMatchObject({ root, writerPid: process.pid });
      expect(path.isAbsolute(spec.module)).toBe(true);
      expect(path.extname(spec.module)).toBe('');
    }
    const cg = CodeGraph.openSync(root, { readOnly: true });
    try { expect(cg.getFile('second.ts')).not.toBeNull(); } finally { cg.close(); }
  });
});
