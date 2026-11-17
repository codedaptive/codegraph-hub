import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobQueue } from '../../../src/extensions/host/builder/queue';
import { JobWatchdog } from '../../../src/extensions/host/builder/job-watchdog';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { coldBuildDatabases } from '../../../src/extensions/host/worktree-lifecycle/cold-build-database';
import { statInode } from '../../../src/directory';

let base: string;
beforeEach(() => {
  endedJobs.replaceAll([]);
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-job-limit-')));
});
afterEach(() => {
  endedJobs.replaceAll([]);
  coldBuildDatabases.clear(path.join(base, 'project'));
  fs.rmSync(base, { recursive: true, force: true });
});

describe('builder job limit restart', () => {
  it.each(['time', 'rss'] as const)('ends a cold build over %s, persists its mark and refuses it after restart', async (limit) => {
    const root = path.join(base, 'project');
    const dir = path.join(root, '.codegraph');
    fs.mkdirSync(dir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(path.join(dir, `codegraph.db${suffix}`), 'partial');
    // The partial database is the running cold build's own, as runColdBuild registers it once init returns.
    coldBuildDatabases.set(root, statInode(path.join(dir, 'codegraph.db')));
    for (const name of ['rebuild.pid', 'writer.pid']) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, mode: 'cold-build', startedAt: 0 }));
    }
    const file = path.join(base, 'ended.jsonl');
    const queue = new JobQueue();
    let finish: () => void = () => undefined;
    const running = queue.enqueue('cold-build', root, () => new Promise<void>((resolve) => { finish = resolve; }));
    let now = 0;
    let rss = 0;
    const logs: string[] = [];
    const exits: number[] = [];
    let beforeExit = 0;
    const watchdog = new JobWatchdog(queue, { maxMs: 1000, maxRssMb: 8 }, {
      clock: () => now, readRssBytes: () => rss,
      onBreach: (job, breach) => endOverLimit(job, breach, {
        jobLog: (line) => logs.push(line), endedFile: new EndedJobsFile(file),
        beforeExit: () => { beforeExit++; }, exit: (code) => exits.push(code),
        pid: process.pid, now: () => new Date('2026-11-16T10:00:00.000Z'),
      }),
    });
    watchdog.check();
    if (limit === 'time') now = 1001;
    else rss = 9 * 1024 * 1024;
    watchdog.check();
    watchdog.check();
    expect(logs).toEqual([limit === 'time'
      ? `2026-11-16T10:00:00.000Z job limit cold-build ${root} time 1001 ms > 1000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried`
      : `2026-11-16T10:00:00.000Z job limit cold-build ${root} rss 9 MB > 8 MB (CODEGRAPH_BUILDER_JOB_MAX_RSS_MB); ended, not retried`]);
    expect(exits).toEqual([75]);
    expect(beforeExit).toBe(1);
    for (const name of ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal', 'rebuild.pid', 'writer.pid']) {
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
    }
    finish();
    await running;
    const journal = new EndedJobsFile(file);
    endedJobs.onClearRoot((cleared) => journal.clearRoot(cleared));
    endedJobs.replaceAll(journal.load());
    expect(endedJobs.has(root, 'cold-build')).toBe(true);
    fs.rmdirSync(dir);
    expect(await runColdBuild(root)).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
    const restarted = new JobQueue();
    // Cold builds are admitted to the queue, but their body refuses at runColdBuild.
    expect(await restarted.enqueue('cold-build', root, () => runColdBuild(root))).toBe(1);
    endedJobs.replaceAll(journal.load());
    expect(await new JobQueue().enqueue('cold-build', root, () => runColdBuild(root))).toBe(1);
    endedJobs.add({ root, kind: 'sync', limit, at: '2026-11-16T10:00:00.000Z' });
    const refused = restarted.enqueue('sync', root, async () => 99);
    await expect(refused).rejects.toBeInstanceOf(JobEndedError);
    await expect(refused).rejects.toMatchObject({ root, kind: 'sync', limit });
    expect(await restarted.enqueue('sync', path.join(base, 'other'), async () => 7)).toBe(7);
    await restarted.enqueue('index', root, async () => undefined);
    expect(endedJobs.has(root, 'cold-build')).toBe(false);
    expect(endedJobs.has(root, 'sync')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    endedJobs.replaceAll(journal.load());
    expect(endedJobs.has(root, 'cold-build')).toBe(false);
    expect(await new JobQueue().enqueue('sync', root, async () => 23)).toBe(23);
  });
});
