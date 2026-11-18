import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vacuumJob } from '../../../src/extensions/host/builder/vacuum-job';

const args = { root: '/project', dbPath: '/project/.codegraph/codegraph.db', minFreelistBytes: 10000 };
const large = { pageSize: 4096, pageCount: 200000, freelistCount: 65536 };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const release = vi.fn();
  const ctx = { writerPid: 12345, progress: vi.fn((_payload: unknown) => {}), reportDatabase: vi.fn() };
  const seams = {
    readStats: vi.fn((): typeof large | null => large),
    freeDisk: vi.fn((): number | null => 3_000_000_000),
    runVacuum: vi.fn(async (_path: string) => {}),
    takeWriterSlot: vi.fn((_root: string, _pid: number):
      | { kind: 'held'; release: () => void }
      | { kind: 'busy'; holder: { pid: number; mode: string; startedAt: number } | null } => ({ kind: 'held', release })),
  };
  return { release, ctx, seams };
}

describe('vacuumJob', () => {
  it('logs a disk-short skip and releases the slot', async () => {
    const { ctx, seams, release } = setup();
    seams.freeDisk.mockReturnValue(0);
    expect(await vacuumJob(args, ctx, seams)).toBe('disk-short');
    expect(seams.freeDisk).toHaveBeenCalledExactlyOnceWith(path.dirname(args.dbPath));
    expect(ctx.progress).toHaveBeenCalledOnce();
    expect(ctx.progress).toHaveBeenCalledWith({ log: expect.stringContaining('vacuum skipped') });
    expect(ctx.progress).toHaveBeenCalledWith({ log: expect.stringContaining(args.root) });
    expect(seams.runVacuum).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it('rechecks the freelist and releases the slot when small', async () => {
    const { ctx, seams, release } = setup();
    seams.readStats.mockReturnValue({ pageSize: 4096, pageCount: 200000, freelistCount: 1 });
    expect(await vacuumJob(args, ctx, seams)).toBe('freelist-small');
    expect(seams.runVacuum).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it('releases the slot when statistics are unavailable', async () => {
    const { ctx, seams, release } = setup();
    seams.readStats.mockReturnValue(null);
    expect(await vacuumJob(args, ctx, seams)).toBe('freelist-small');
    expect(seams.runVacuum).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it('runs vacuum on the database with ample disk', async () => {
    const { ctx, seams } = setup();
    expect(await vacuumJob(args, ctx, seams)).toBe('vacuum');
    expect(seams.readStats).toHaveBeenCalledExactlyOnceWith(args.dbPath);
    expect(seams.runVacuum).toHaveBeenCalledExactlyOnceWith(args.dbPath);
  });
  it('skips a busy writer without reading statistics or vacuuming', async () => {
    const { ctx, seams } = setup();
    seams.takeWriterSlot.mockReturnValue({ kind: 'busy', holder: { pid: 6789, mode: 'watch', startedAt: 1 } });
    expect(await vacuumJob(args, ctx, seams)).toBe('writer-held');
    expect(seams.takeWriterSlot).toHaveBeenCalledExactlyOnceWith(args.root, 12345);
    expect(ctx.progress).toHaveBeenCalledOnce();
    expect(ctx.progress).toHaveBeenCalledWith({ log: expect.stringContaining('vacuum skipped') });
    expect(ctx.progress).toHaveBeenCalledWith({ log: expect.stringContaining(args.root) });
    expect(ctx.progress).toHaveBeenCalledWith({ log: expect.stringContaining('6789') });
    expect(seams.readStats).not.toHaveBeenCalled();
    expect(seams.freeDisk).not.toHaveBeenCalled();
    expect(seams.runVacuum).not.toHaveBeenCalled();
  });
  it('holds the slot until the vacuum settles, then releases it once', async () => {
    const { ctx, seams, release } = setup();
    let finish = () => {};
    seams.runVacuum.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const result = vacuumJob(args, ctx, seams);
    expect(seams.runVacuum).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe('vacuum');
    expect(release).toHaveBeenCalledOnce();
    expect(seams.runVacuum.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  });
  it('releases the slot when vacuum rejects', async () => {
    const { ctx, seams, release } = setup();
    seams.runVacuum.mockRejectedValue(new Error('vacuum failed'));
    await expect(vacuumJob(args, ctx, seams)).rejects.toThrow('vacuum failed');
    expect(release).toHaveBeenCalledOnce();
  });
});
