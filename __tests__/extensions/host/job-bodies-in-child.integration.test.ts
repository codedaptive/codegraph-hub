import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { testJobSupervisor } from './helpers/test-job-supervisor';

describe('job bodies in child processes', { timeout: 90_000 }, () => {
  let base: string;
  let root: string;
  let holders: HolderSet;
  const supervisor = testJobSupervisor();

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-child-bodies-')));
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
    await supervisor.killAll();
    await holders?.closeAll();
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function setup(runJob: (id: number, spec: JobSpec, progress?: (payload: unknown) => void) => Promise<unknown>): void {
    const queue = new JobQueue({ loadAverage: () => 0 });
    holders = new HolderSet({
      queue, fences: new RebuildFences(queue, () => undefined),
      onFreshness: () => undefined, log: () => undefined, watchOptions: () => ({}),
      openWaitMs: 30_000, recoverWaitMs: 5_000, ownRetryMs: 50, pollMs: 100,
      ...{ runJob },
    });
  }

  it('loads a real TypeScript source module in the child through the require hook', async () => {
    await expect(supervisor.run(900, {
      kind: 'sync', root, writerPid: process.pid,
      module: path.resolve(__dirname, '../../../src/extraction/wasm-runtime-flags'),
      export: 'nodeRuntimeFlagsFor', args: '22.5.0',
    })).resolves.toEqual(['--disable-warning=ExperimentalWarning', '--max-semi-space-size=16']);
  });

  it('runs a held root sync in a distinct child and indexes the changed file', async () => {
    let syncPid: number | null = null;
    setup((id, spec, progress) => {
      const result = supervisor.run(id, spec, progress);
      if (spec.kind === 'sync') syncPid = supervisor.childPid(id);
      return result;
    });
    expect(await holders.hold(root)).toMatchObject({ kind: 'held' });
    await holders.caughtUp(root);
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 2;\n');
    execFileSync('git', ['-C', root, 'add', 'second.ts']);
    expect(await holders.sync(root)).toEqual({ filesChanged: 1 });
    expect(syncPid).not.toBeNull();
    expect(syncPid).not.toBe(process.pid);
    const cg = CodeGraph.openSync(root, { readOnly: true });
    try { expect(cg.getFile('second.ts')).not.toBeNull(); } finally { cg.close(); }
  });

  it('keeps the held writer lock after killing a sync child and permits the next sync', async () => {
    let killNext = true;
    let killed = false;
    setup((id, spec, progress) => {
      const result = supervisor.run(id, spec, progress);
      if (spec.kind === 'sync' && killNext) {
        killNext = false;
        killed = supervisor.childPid(id) !== null;
        void supervisor.kill(id);
      }
      return result;
    });
    expect(await holders.hold(root)).toMatchObject({ kind: 'held' });
    await holders.caughtUp(root);
    fs.writeFileSync(path.join(root, 'second.ts'), 'export const second = 2;\n');
    execFileSync('git', ['-C', root, 'add', 'second.ts']);
    await expect(holders.sync(root)).rejects.toThrow();
    expect(killed).toBe(true);
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    expect(await holders.sync(root)).toEqual({ filesChanged: 1 });
    const cg = CodeGraph.openSync(root, { readOnly: true });
    try { expect(cg.getFile('second.ts')).not.toBeNull(); } finally { cg.close(); }
  });
});
