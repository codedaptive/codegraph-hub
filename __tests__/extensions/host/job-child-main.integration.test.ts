import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { JobSupervisor } from '../../../src/extensions/host/builder/job-supervisor';

const fixture = path.resolve(__dirname, '../../fixtures/job-process-bodies.cjs');
const source = path.resolve(__dirname, '../../../src/extensions/host/builder/job-child-main.ts');
const spec = (name: string) => ({ kind: 'sync' as const, root: '/root', module: fixture, export: name, args: null, writerPid: 123 });
let dir: string;
let entry: string;
let supervisor: JobSupervisor;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-child-entry-'));
  entry = path.join(dir, 'job-child-main.js');
  const output = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  if (/require\s*\(\s*['"]\.{1,2}\//.test(output)) throw new Error('transpiled child entry contains a relative require');
  fs.writeFileSync(entry, output);
  supervisor = new JobSupervisor({ entry, execArgv: [] });
});

afterAll(async () => {
  await supervisor?.killAll();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('real job child entry', () => {
  it('delivers progress in order before its result', async () => {
    const events: unknown[] = [];
    const result = await supervisor.run(1, spec('progress'), (payload) => { events.push(payload); });
    events.push(result);
    expect(events).toEqual(['first', 'second', { answer: 42 }]);
  });

  it('rejects with a thrown body message', async () => {
    await expect(supervisor.run(2, spec('fail'))).rejects.toThrow('fixture failed');
  });

  it('rejects naming a missing export', async () => {
    await expect(supervisor.run(3, spec('absentBody'))).rejects.toThrow('absentBody');
  });

  it('reports the created database identity', async () => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const job = supervisor.run(4, spec('database'), () => ready());
    const rejected = expect(job).rejects.toThrow();
    try {
      await started;
      expect(supervisor.createdDatabase(4)).toBe('device:inode');
    } finally {
      await supervisor.kill(4);
      await rejected;
    }
  });

  it('exits by itself after delivering the result', async () => {
    await expect(supervisor.run(5, spec('progress'))).resolves.toEqual({ answer: 42 });
    expect(supervisor.childPid(5)).toBeNull();
  });

  it('exits with code 1 when the supervisor disconnects', async () => {
    const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', () => resolve());
        child.send({ type: 'spec', spec: spec('hold') });
      });
      child.disconnect();
      await expect(Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('child did not exit after disconnect')), 5_000).unref()),
      ])).resolves.toEqual({ code: 1, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
