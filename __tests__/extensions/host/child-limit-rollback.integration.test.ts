import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runColdBuild } from '../../../src/extensions/host/worktree-lifecycle/cold-build';
import { statInode } from '../../../src/directory';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';
import { testJobSupervisor } from './helpers/test-job-supervisor';

const fixture = path.resolve(__dirname, 'fixtures/hanging-leftovers.cjs');
const supervisor = testJobSupervisor();
const breach = { limit: 'time' as const, maxMs: 1000, measuredMs: 1001 };
const suffixes = ['', '-wal', '-shm', '-journal'];
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-child-limit-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
});
afterEach(async () => {
  await supervisor.killAll();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(kind: 'seed' | 'cold-build', body?: string) {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const job = supervisor.run(1, { kind, root, module: fixture, export: body ?? (kind === 'seed' ? 'seed' : 'coldBuild'), args: { root }, writerPid: process.pid }, () => ready());
  const rejected = expect(job).rejects.toThrow();
  await Promise.race([started, job.then(() => { throw new Error('fixture returned'); })]);
  const pid = supervisor.childPid(1);
  if (pid === null) throw new Error('fixture has no child');
  return { pid, rejected };
}

async function end(kind: 'seed' | 'cold-build', pid: number) {
  await endOverLimit({ kind, root }, breach, {
    jobLog: () => {}, endedFile: { append: () => {} },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    child: { pid, createdDatabase: supervisor.createdDatabase(1), kill: () => supervisor.kill(1) },
  });
}

describe('child limit rollback', { timeout: 90_000 }, () => {
  it('rebuilds a schema-less database left by a killed child before identity reporting', async () => {
    vi.stubEnv('CODEGRAPH_STATE_DIR', path.join(root, 'state'));
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'alpha.ts'), 'export function alpha() {}\n');
    const { pid, rejected } = await start('cold-build', 'coldBuildWithoutIdentity');
    expect(supervisor.createdDatabase(1)).toBeNull();
    await end('cold-build', pid);
    await rejected;
    expect(await runColdBuild(root)).toBe(0);
    const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toEqual({ name: 'nodes' });
    } finally {
      db.close();
    }
  });

  it('removes a killed seed child staging copy and its side files', async () => {
    const { pid, rejected } = await start('seed');
    const staging = path.join(root, '.codegraph', `codegraph.db.seed-${pid}-0a1b2c3d.tmp`);
    for (const suffix of suffixes) expect(fs.existsSync(staging + suffix)).toBe(true);
    await end('seed', pid);
    await rejected;
    for (const suffix of suffixes) expect(fs.existsSync(staging + suffix)).toBe(false);
  });
  it('removes a killed cold child database, side files and rebuild lock', async () => {
    const { pid, rejected } = await start('cold-build');
    const db = path.join(root, '.codegraph', 'codegraph.db');
    expect(supervisor.createdDatabase(1)).toBe(statInode(db));
    for (const suffix of suffixes) expect(fs.existsSync(db + suffix)).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(true);
    await end('cold-build', pid);
    await rejected;
    for (const suffix of suffixes) expect(fs.existsSync(db + suffix)).toBe(false);
    expect(fs.existsSync(path.join(root, '.codegraph', 'rebuild.pid'))).toBe(false);
  });
});
