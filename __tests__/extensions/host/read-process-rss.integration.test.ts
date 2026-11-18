import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { JobSupervisor } from '../../../src/extensions/host/builder/job-supervisor';
import { readProcessRssBytes } from '../../../src/extensions/host/builder/read-process-rss';

describe('readProcessRssBytes', () => {
  it('reads a memory-holding child and returns null after that child exits', async () => {
    const supervisor = new JobSupervisor({ entry: path.resolve(__dirname, '../../fixtures/job-process-entry.cjs'), execArgv: [] });
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const job = supervisor.run(1, { kind: 'sync', root: '/root', module: path.resolve(__dirname, '../../fixtures/job-process-bodies.cjs'), export: 'memory', args: null, writerPid: 123 }, () => ready());
    const rejected = expect(job).rejects.toThrow();
    try {
      await started;
      const pid = supervisor.childPid(1);
      expect(pid).not.toBeNull();
      if (pid === null) throw new Error('no child pid');
      expect(await readProcessRssBytes(pid)).toBeGreaterThan(150 * 1024 * 1024);
      await supervisor.kill(1);
      await rejected;
      expect(await readProcessRssBytes(pid)).toBeNull();
    } finally {
      await supervisor.killAll();
    }
  });
});
