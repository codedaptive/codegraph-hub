import { inProcessJobRunner } from './helpers/in-process-job-runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HolderSet } from '../../../src/extensions/host/builder/holder';
import { RebuildFences } from '../../../src/extensions/host/builder/fences';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';

vi.mock('../../../src/directory', async (original) => ({
  ...await original<typeof import('../../../src/directory')>(), isInitialized: () => true,
}));
vi.mock('../../../src/mcp/writer-lock', async (original) => ({
  ...await original<typeof import('../../../src/mcp/writer-lock')>(),
  tryAcquireWriterLock: () => ({ kind: 'taken', existing: null, pidPath: '' }),
  readWriterLock: () => null,
}));

let root: string;
beforeEach(() => {
  endedJobs.replaceAll([]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-holder-ended-')));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  endedJobs.replaceAll([]);
  fs.rmSync(root, { recursive: true, force: true });
});

it('logs an ended own-retry open once and does not re-arm it', async () => {
  const queue = new JobQueue();
  const enqueue = vi.spyOn(queue, 'enqueue');
  const lines: string[] = [];
  const holders = new HolderSet({ runJob: inProcessJobRunner().runJob,
    queue, fences: new RebuildFences(queue, (line) => lines.push(line)),
    onFreshness: () => undefined, log: (line) => lines.push(line), watchOptions: () => ({}),
    openWaitMs: 10000, recoverWaitMs: 1000, ownRetryMs: 50, pollMs: 1000,
  });
  try {
    expect(await holders.hold(root)).toEqual({ kind: 'held', root });
    enqueue.mockImplementation(() => Promise.reject(new JobEndedError(root, 'open', 'time')));
    await vi.advanceTimersByTimeAsync(50);
    expect(enqueue.mock.calls.filter(([kind]) => kind === 'open')).toHaveLength(2);
    expect(lines.filter((line) => line.includes('could not take over') && line.includes(root))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(enqueue.mock.calls.filter(([kind]) => kind === 'open')).toHaveLength(2);
    expect(lines.filter((line) => line.includes('could not take over') && line.includes(root))).toHaveLength(1);
  } finally {
    await holders.closeAll();
  }
});
