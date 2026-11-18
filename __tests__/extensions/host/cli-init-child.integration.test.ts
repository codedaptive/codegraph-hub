import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { testJobSupervisor } from './helpers/test-job-supervisor';

describe('CLI init in a job child', { timeout: 90_000 }, () => {
  let base: string;
  let root: string;
  let service: BuilderService;
  const supervisor = testJobSupervisor();

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-init-child-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'first.ts'), 'export const first = 1;\n');
    execFileSync('git', ['-C', root, 'add', 'first.ts']);
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(base, 'state'));
  });

  afterEach(async () => {
    await supervisor.killAll();
    await service?.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('forwards child progress in order and leaves a readable index on disk', async () => {
    const messages: BuilderToServer[] = [];
    const childProgress: unknown[] = [];
    let childPid: number | null = null;
    const runJob = (id: number, spec: JobSpec, progress?: (payload: unknown) => void): Promise<unknown> => {
      const result = supervisor.run(id, spec, (payload) => {
        childProgress.push(payload);
        progress?.(payload);
      });
      if (spec.kind === 'init') childPid = supervisor.childPid(id);
      return result;
    };
    service = new BuilderService({
      send: (message) => messages.push(message), jobLog: () => undefined, log: () => undefined,
      watchOptions: () => ({}), housekeeping: false, ...{ runJob },
    });
    await service.handle({ id: 41, op: 'cliIndex', root, mode: 'init' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 41, ok: true, result: expect.objectContaining({ success: true }) }));
    expect(childPid).not.toBeNull();
    expect(childPid).not.toBe(process.pid);
    expect(childProgress.length).toBeGreaterThan(0);
    expect(messages.filter((message) => 'op' in message && message.op === 'requestEvent' && message.event.kind === 'progress')
      .map((message) => 'event' in message && message.event.kind === 'progress' ? message.event.progress : null))
      .toEqual(childProgress);
    const cg = CodeGraph.openSync(root, { readOnly: true });
    try { expect(cg.getFile('first.ts')).not.toBeNull(); } finally { cg.close(); }
  });
});
