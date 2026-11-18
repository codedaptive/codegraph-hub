import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../../../src/index';
import { BuilderService } from '../../../src/extensions/host/builder/service';
import type { BuilderToServer } from '../../../src/extensions/host/builder/protocol';
import type { JobSpec } from '../../../src/extensions/host/builder/job-spec-type';
import { readWriterLock } from '../../../src/mcp/writer-lock';
import { testJobSupervisor } from './helpers/test-job-supervisor';

describe('leased rebuild in a child', { timeout: 90_000 }, () => {
  let base: string;
  let root: string;
  let service: BuilderService;
  const supervisor = testJobSupervisor();

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-rebuild-child-')));
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
    await supervisor.killAll();
    await service?.stop(0);
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('rebuilds in a child under the parent writer lock and releases that lock at unfence', async () => {
    const messages: BuilderToServer[] = [];
    let during: ReturnType<typeof readWriterLock> = null;
    let childPid: number | null = null;
    const runJob = (id: number, spec: JobSpec, progress?: (payload: unknown) => void): Promise<unknown> => {
      during = readWriterLock(root);
      const result = supervisor.run(id, spec, progress);
      childPid = supervisor.childPid(id);
      return result;
    };
    service = new BuilderService({
      send: (message) => messages.push(message), jobLog: () => undefined, log: () => undefined,
      watchOptions: () => ({}), housekeeping: false, ...{ runJob },
    });
    await service.handle({ id: 1, op: 'fence', root });
    await service.handle({ id: 2, op: 'cliIndex', root, mode: 'rebuild' });
    expect(messages).toContainEqual(expect.objectContaining({ id: 2, ok: true, result: expect.objectContaining({ success: true }) }));
    expect(childPid).not.toBeNull();
    expect(childPid).not.toBe(process.pid);
    expect(during).toMatchObject({ pid: process.pid, mode: 'rebuild' });
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'rebuild' });
    const cg = CodeGraph.openSync(root, { readOnly: true });
    try { expect(cg.getFile('first.ts')).not.toBeNull(); } finally { cg.close(); }
    await service.handle({ id: 3, op: 'unfence', root });
    expect(readWriterLock(root)).toBeNull();
  });
});
