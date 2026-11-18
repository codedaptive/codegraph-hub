import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statInode } from '../../../src/directory';
import { endJobsAfterGrace } from '../../../src/extensions/host/builder/end-jobs-after-grace';
import { testJobSupervisor } from './helpers/test-job-supervisor';

const fixture = path.resolve(__dirname, 'fixtures/hanging-leftovers.cjs');
const supervisor = testJobSupervisor();
const suffixes = ['', '-wal', '-shm', '-journal'];
let base: string;
let seedRoot: string;
let coldRoot: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grace-rollback-')));
  seedRoot = path.join(base, 'seed');
  coldRoot = path.join(base, 'cold');
  for (const root of [seedRoot, coldRoot]) fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
});
afterEach(async () => {
  await supervisor.killAll();
  fs.rmSync(base, { recursive: true, force: true });
});

async function start(id: number, kind: 'seed' | 'cold-build', root: string, exportName = kind === 'seed' ? 'seed' : 'coldBuild') {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const job = supervisor.run(id, { kind, root, module: fixture, export: exportName, args: { root }, writerPid: process.pid }, () => ready());
  const rejected = expect(job).rejects.toThrow();
  await Promise.race([started, job.then(() => { throw new Error('fixture returned'); })]);
  const pid = supervisor.childPid(id);
  if (pid === null) throw new Error('fixture has no child');
  return { pid, rejected };
}

describe('ending jobs after grace', { timeout: 90_000 }, () => {
  it.runIf(process.platform !== 'win32')('killAll returns the identities and roots of the jobs it killed (POSIX)', async () => {
    const seed = await start(1, 'seed', seedRoot);
    const cold = await start(2, 'cold-build', coldRoot);
    const identity = statInode(path.join(coldRoot, '.codegraph', 'codegraph.db'));
    expect(identity).not.toBeNull();
    const killed = await supervisor.killAll();
    expect(killed).toHaveLength(2);
    expect(killed).toEqual(expect.arrayContaining([
      { kind: 'seed', root: seedRoot, pid: seed.pid, createdDatabase: null },
      { kind: 'cold-build', root: coldRoot, pid: cold.pid, createdDatabase: identity },
    ]));
    await Promise.all([seed.rejected, cold.rejected]);
  });

  // statInode reports no identity on win32 (src/directory.ts), so the cold build reports none there.
  it.runIf(process.platform === 'win32')('killAll returns the roots of the jobs it killed and no database identity (Windows)', async () => {
    const seed = await start(1, 'seed', seedRoot);
    const cold = await start(2, 'cold-build', coldRoot);
    expect(statInode(path.join(coldRoot, '.codegraph', 'codegraph.db'))).toBeNull();
    const killed = await supervisor.killAll();
    expect(killed).toHaveLength(2);
    expect(killed).toEqual(expect.arrayContaining([
      { kind: 'seed', root: seedRoot, pid: seed.pid, createdDatabase: null },
      { kind: 'cold-build', root: coldRoot, pid: cold.pid, createdDatabase: null },
    ]));
    await Promise.all([seed.rejected, cold.rejected]);
  });

  it('removes both killed children\'s partial work and the cold build lock', async () => {
    const seed = await start(1, 'seed', seedRoot);
    const cold = await start(2, 'cold-build', coldRoot);
    const staging = path.join(seedRoot, '.codegraph', `codegraph.db.seed-${seed.pid}-0a1b2c3d.tmp`);
    const db = path.join(coldRoot, '.codegraph', 'codegraph.db');
    const rebuild = path.join(coldRoot, '.codegraph', 'rebuild.pid');
    for (const suffix of suffixes) {
      expect(fs.existsSync(staging + suffix)).toBe(true);
      expect(fs.existsSync(db + suffix)).toBe(true);
    }
    expect(fs.existsSync(rebuild)).toBe(true);
    await endJobsAfterGrace(supervisor);
    await Promise.all([seed.rejected, cold.rejected]);
    for (const suffix of suffixes) {
      expect(fs.existsSync(staging + suffix)).toBe(false);
      expect(fs.existsSync(db + suffix)).toBe(false);
    }
    expect(fs.existsSync(rebuild)).toBe(false);
  });

  it('removes a cold build\'s database and lock when the build reported no identity and no other process holds writer.pid', async () => {
    const cold = await start(2, 'cold-build', coldRoot, 'coldBuildWithoutIdentity');
    const db = path.join(coldRoot, '.codegraph', 'codegraph.db');
    const rebuild = path.join(coldRoot, '.codegraph', 'rebuild.pid');
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.existsSync(rebuild)).toBe(true);
    const killed = await supervisor.killAll();
    expect(killed).toEqual([{ kind: 'cold-build', root: coldRoot, pid: cold.pid, createdDatabase: null }]);
    await cold.rejected;
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.existsSync(rebuild)).toBe(true);
    await endJobsAfterGrace({ killAll: async () => killed });
    for (const suffix of suffixes) expect(fs.existsSync(db + suffix)).toBe(false);
    expect(fs.existsSync(rebuild)).toBe(false);
  });
});
