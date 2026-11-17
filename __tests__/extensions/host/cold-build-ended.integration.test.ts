import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../../src/index';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';

let root: string;
beforeEach(() => {
  endedJobs.replaceAll([]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ended-cold-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  endedJobs.replaceAll([]);
  fs.rmSync(root, { recursive: true, force: true });
});

it('refuses an ended cold build before taking a lock or creating the data directory', async () => {
  endedJobs.add({ root, kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' });
  const init = vi.spyOn(CodeGraph, 'init').mockRejectedValue(new Error('must not initialize'));
  expect(await runColdBuild(root)).toBe(1);
  expect(init).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
});
