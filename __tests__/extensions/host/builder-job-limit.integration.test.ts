import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import { JobWatchdog } from '../../../src/extensions/host/builder/job-watchdog';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { testJobSupervisor } from './helpers/test-job-supervisor';

const supervisor = testJobSupervisor();
let base: string;
let service: BuilderService | undefined;
beforeEach(() => {
  endedJobs.replaceAll([]);
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-job-limit-')));
});
afterEach(async () => {
  await supervisor.killAll();
  await service?.stop(0);
  service = undefined;
  endedJobs.replaceAll([]);
  fs.rmSync(base, { recursive: true, force: true });
});

describe('builder job limit', { timeout: 90_000 }, () => {
  it.each(['time', 'rss'] as const)('ends an over-%s child, records the mark and runs a later job in another child', async (limit) => {
    const root = path.join(base, 'project');
    const other = path.join(base, 'other');
    fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    fs.mkdirSync(other);
    const journal = new EndedJobsFile(path.join(base, 'ended.jsonl'));
    const lines: string[] = [];
    service = new BuilderService({
      send: () => {}, jobLog: (line) => { lines.push(line); }, log: () => {},
      watchOptions: () => ({}), housekeeping: false, runJob: supervisor.run.bind(supervisor),
    });
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let id = 0;
    const running = service.queue.enqueue('cold-build', root, (job) => {
      id = job.id;
      return supervisor.run(id, {
        kind: 'cold-build', root, writerPid: process.pid,
        module: path.resolve(__dirname, 'fixtures/hanging-leftovers.cjs'), export: 'coldBuild', args: { root },
      }, () => ready());
    });
    const rejected = expect(running).rejects.toThrow();
    await Promise.race([started, running.then(() => { throw new Error('fixture returned'); })]);
    const pid = supervisor.childPid(id);
    if (pid === null) throw new Error('missing child');
    expect(pid).not.toBe(process.pid);
    let now = 0;
    let ended: Promise<void> | undefined;
    const watchdog = new JobWatchdog(service.queue, { maxMs: 1, maxRssMb: 8 }, {
      clock: () => now, childPid: (jobId) => supervisor.childPid(jobId), readChildRssBytes: async () => limit === 'rss' ? 9437184 : 0,
      onBreach: (job, breach, childPid) => {
        if (childPid === null) throw new Error('missing child');
        ended = endOverLimit(job, breach, {
          jobLog: (line) => { lines.push(line); }, endedFile: journal, now: () => new Date('2026-11-16T10:00:00.000Z'),
          child: { pid: childPid, createdDatabase: supervisor.createdDatabase(job.id), kill: () => supervisor.kill(job.id) },
        });
      },
    });
    await watchdog.check();
    now = 2;
    await watchdog.check();
    expect(ended).toBeDefined();
    await ended;
    await rejected;
    expect(journal.load()).toEqual([{ root, kind: 'cold-build', limit, at: '2026-11-16T10:00:00.000Z' }]);
    expect(lines.some((line) => line.includes(limit === 'time'
      ? `job limit cold-build ${root} time 2 ms > 1 ms`
      : `job limit cold-build ${root} rss 9 MB > 8 MB`))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
    expect(await service.queue.enqueue('sync', other, ({ id: nextId }) => supervisor.run(nextId, {
      kind: 'sync', root: other, writerPid: process.pid,
      module: path.resolve(__dirname, 'fixtures/job-process-bodies.cjs'), export: 'progress', args: null,
    }))).toEqual({ answer: 42 });
  });
});
