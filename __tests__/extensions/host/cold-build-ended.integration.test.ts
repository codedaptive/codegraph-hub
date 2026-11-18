import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import CodeGraph from '../../../src/index';
import { coldBuildJob } from '../../../src/extensions/host/builder/cold-build-job';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { inProcessJobRunner } from './helpers/in-process-job-runner';

let root: string;
beforeEach(() => {
  endedJobs.replaceAll([]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ended-cold-')));
  execFileSync('git', ['init', '-q', root]);
});
afterEach(() => {
  vi.restoreAllMocks();
  endedJobs.replaceAll([]);
  fs.rmSync(root, { recursive: true, force: true });
});

it('refuses an ended cold build before taking a lock or creating the data directory', async () => {
  endedJobs.add({ root, kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' });
  const init = vi.spyOn(CodeGraph, 'init').mockRejectedValue(new Error('must not initialize'));
  const runJob = vi.fn(inProcessJobRunner().runJob);
  await expect(coldBuildJob(1, root, { realRoot: root }, {
    runJob, attempts: 1, delayMs: 0, onFailed: () => {},
  })).rejects.toMatchObject({ name: 'JobEndedError', root, kind: 'cold-build', limit: 'time' });
  expect(runJob).not.toHaveBeenCalled();
  expect(init).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
});
