import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { statInode } from '../../../src/directory';
import { endOverLimit } from '../../../src/extensions/host/builder/job-limit-guard';

const breach = { limit: 'time' as const, maxMs: 3600000, measuredMs: 3600001 };
const at = '2026-11-16T10:00:00.000Z';
const dbNames = ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal'];
let root: string;
let dir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-guard-')));
  dir = path.join(root, '.codegraph');
  fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function lock(name: string, pid: number): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, mode: 'cold-build', startedAt: 0 }));
}
function deps(pid: number, createdDatabase: string | null, kill: () => Promise<boolean>) {
  return { jobLog: vi.fn(), endedFile: { append: vi.fn() }, now: () => new Date(at), child: { pid, createdDatabase, kill } };
}

describe('endOverLimit with a child', () => {
  it('leaves the job unmarked and its files intact when the child was not killed', async () => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'partial');
    lock('rebuild.pid', 123);
    const options = deps(123, statInode(path.join(dir, 'codegraph.db')), async () => false);
    await endOverLimit({ kind: 'cold-build', root }, breach, options);
    expect(options.jobLog).not.toHaveBeenCalled();
    expect(options.endedFile.append).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('partial');
  });

  it("kills first, keeps the hold's writer lock and removes the child's rebuild lock", async () => {
    lock('rebuild.pid', 123);
    lock('writer.pid', 456);
    let release: (killed: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    const options = deps(123, null, () => gate);
    const ending = endOverLimit({ kind: 'sync', root }, breach, options);
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(true);
    expect(options.jobLog).not.toHaveBeenCalled();
    release(true);
    await ending;
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(true);
    expect(options.jobLog).toHaveBeenCalledOnce();
    expect(options.endedFile.append).toHaveBeenCalledExactlyOnceWith({ root, kind: 'sync', limit: 'time', at });
  });
  it('removes a child-owned writer lock', async () => {
    lock('writer.pid', 123);
    await endOverLimit({ kind: 'sync', root }, breach, deps(123, null, async () => true));
    expect(fs.existsSync(path.join(dir, 'writer.pid'))).toBe(false);
  });
  it.each(['match', 'mismatch', 'null'] as const)('child cold database identity %s controls rollback', async (identity) => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'partial');
    lock('rebuild.pid', 123);
    const createdDatabase = identity === 'match' ? statInode(path.join(dir, 'codegraph.db')) : identity === 'mismatch' ? 'different' : null;
    await endOverLimit({ kind: 'cold-build', root }, breach, deps(123, createdDatabase, async () => true));
    expect(fs.existsSync(path.join(dir, 'rebuild.pid'))).toBe(false);
    for (const name of dbNames) expect(fs.existsSync(path.join(dir, name))).toBe(identity === 'mismatch');
  });
  it.each(['init', 'index'] as const)('keeps a user database when a %s child reports its identity', async (kind) => {
    for (const name of dbNames) fs.writeFileSync(path.join(dir, name), 'user data');
    lock('rebuild.pid', 123);
    const identity = statInode(path.join(dir, 'codegraph.db'));
    expect(identity).not.toBeNull();
    await endOverLimit({ kind, root }, breach, deps(123, identity, async () => true));
    for (const name of dbNames) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe('user data');
  });

  it('removes only seed staging files owned by the child', async () => {
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'), 'child');
    fs.writeFileSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'), 'builder');
    await endOverLimit({ kind: 'seed', root }, breach, deps(123, null, async () => true));
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-123-0a1b2c3d.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'codegraph.db.seed-456-0a1b2c3d.tmp'))).toBe(true);
  });
});
