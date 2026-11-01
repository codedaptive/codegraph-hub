/**
 * Dead-lock reclaim, unit level: the lock records a holder leaves when it is
 * SIGKILL'd holding them do not block the next taker. The holder here is a
 * victim fixture that takes the locks through the real code, not a server;
 * dead-lock-reclaim.gate.test.ts kills real servers mid-write.
 *
 * A lock whose pid is dead is reclaimed by pid liveness. The case these tests
 * cover is pid reuse: the killed holder's pid now names an unrelated live
 * process. On POSIX, a lock record written when the holder's OS process start
 * time can be read carries it (field START_FIELD, recorded through lockStamp),
 * and the records these tests write all do. A record whose pid is alive but
 * whose recorded start time differs from that pid's current start time is
 * stale, at the project's own root too. A record without the field (the
 * lookup failed, or the record is in the older format) is decided by pid
 * liveness. A `.takeover` guard older than 50 seconds (lock-takeover.ts
 * STALE_GUARD_MS) is stale even when its pid is alive.
 *
 * Records are written by a victim process through the real code
 * (fixtures/dead-lock-victim.ts), then the victim is SIGKILL'd and only the
 * pid in each record is moved to a live `sleep 600` (fixtures/dead-lock-helpers.ts
 * reusePid). The same victim, alive, first proves a genuine live holder is
 * still respected.
 *
 * POSIX only: Windows records no start time and keeps liveness alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../../../src';
import { FileLock } from '../../../src/utils';
import { getCodeGraphDir } from '../../../src/directory';
import {
  decodeWriterLockInfo,
  getWriterPidPath,
  isForeignLockRecord,
  isRebuildInProgress,
  lockStamp,
  readWriterLock,
  tryAcquireWriterLock,
} from '../../../src/mcp/writer-lock';
import {
  START_FIELD,
  STALE_GUARD_AGE_S,
  deadPid,
  isAlive,
  killAndWait,
  killStarted,
  plantGuard,
  reusePid,
  startUnrelatedHolder,
  startVictim,
} from './fixtures/dead-lock-helpers';

const posix = process.platform !== 'win32';

async function makeProject(prefix: string): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const cg = await CodeGraph.init(root);
  cg.close();
  return root;
}

function codegraphLockOf(root: string): FileLock {
  // The owner CodeGraph's constructor passes (src/index.ts).
  return new FileLock(path.join(getCodeGraphDir(root), 'codegraph.lock'), {
    stamp: () => lockStamp(root),
    isForeign: (r) => isForeignLockRecord(r, root),
  });
}

describe.runIf(posix)('dead-lock reclaim: records carry the holder start time', () => {
  let root: string;
  beforeEach(async () => { root = await makeProject('cg-dlr-stamp-'); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lockStamp records this process start time as a non-empty string', () => {
    const stamp = lockStamp(root) as unknown as Record<string, unknown>;
    expect(typeof stamp[START_FIELD], `lockStamp has no ${START_FIELD}: ${JSON.stringify(stamp)}`).toBe('string');
    expect((stamp[START_FIELD] as string).length).toBeGreaterThan(0);
  });
});

// One victim per describe, a separate node process running the real src code (more time under load):
// it is the only way to get records written by the real code for a pid that
// is not this worker's. The tests run in order: live first, then killed + reused.
describe.runIf(posix)('dead-lock reclaim: a reused pid in a record the code wrote', () => {
  let root: string;
  let victim: number;
  let holder: number;
  let lockFile: string;
  let writerPid: string;
  let rebuildPid: string;

  beforeAll(async () => {
    root = await makeProject('cg-dlr-reuse-');
    victim = await startVictim(root, ['writer', 'rebuild', 'filelock']);
    lockFile = path.join(getCodeGraphDir(root), 'codegraph.lock');
    writerPid = getWriterPidPath(root);
    rebuildPid = getWriterPidPath(root, 'rebuild.pid');
  }, 60_000);

  afterAll(() => {
    killStarted();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('while the victim lives, every lock it holds is held (regression guard)', () => {
    expect(readWriterLock(root)?.pid).toBe(victim);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('taken');
    expect(isRebuildInProgress(root)).toBe(true);
    expect(() => codegraphLockOf(root).acquire()).toThrow(/locked by another process/);
  });

  it('after the victim is killed and its pid reused, the records name the live holder', async () => {
    const victimStarted = Date.now(); // the victim started before this point
    await killAndWait(victim);
    holder = await startUnrelatedHolder(victimStarted);
    for (const f of [writerPid, rebuildPid, lockFile]) reusePid(f, victim, holder);
    expect(isAlive(holder)).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf8').split('\n')[0]).toBe(String(holder));
  }, 20_000);

  it('rebuild.pid: isRebuildInProgress is false', () => {
    expect(JSON.parse(fs.readFileSync(rebuildPid, 'utf8')).pid).toBe(holder);
    expect(isRebuildInProgress(root)).toBe(false);
  });

  it('writer.pid: the record is foreign/stale and reads as no holder', () => {
    const raw = fs.readFileSync(writerPid, 'utf8');
    expect(JSON.parse(raw).pid).toBe(holder);
    expect(isForeignLockRecord(JSON.parse(raw), root)).toBe(true);
    expect(decodeWriterLockInfo(raw, root)).toBeNull();
    expect(readWriterLock(root)).toBeNull();
  });

  it('writer.pid: tryAcquireWriterLock reclaims it', () => {
    const r = tryAcquireWriterLock(root, 'direct');
    expect(r.kind).toBe('acquired');
    expect(readWriterLock(root)?.pid).toBe(process.pid);
  });

  it('codegraph.lock: FileLock.acquire reclaims it', () => {
    const lock = codegraphLockOf(root);
    expect(() => lock.acquire()).not.toThrow();
    expect(fs.readFileSync(lockFile, 'utf8').split('\n')[0]).toBe(String(process.pid));
    lock.release();
  });

  it('the unrelated holder was never signalled', () => {
    expect(isAlive(holder)).toBe(true);
  });
});

describe.runIf(posix)('dead-lock reclaim: an older-format record (no start time) with a live pid', () => {
  let root: string;
  let holder: number;

  beforeEach(async () => {
    root = await makeProject('cg-dlr-old-');
    holder = await startUnrelatedHolder(0);
  });
  afterEach(() => {
    killStarted();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A record the way the code wrote it before START_FIELD: this project's
   * stamp without the writer fields added with it (START_FIELD and the
   * stamp's `pid`, which would otherwise overwrite the holder's pid).
   */
  function olderFormat(mode: string): string {
    const stamp = lockStamp(root) as unknown as Record<string, unknown>;
    delete stamp[START_FIELD];
    delete stamp.pid;
    return JSON.stringify({ pid: holder, mode, startedAt: Date.now() - 60_000, ready: true, ...stamp }) + '\n';
  }

  it('writer.pid stays held', () => {
    fs.writeFileSync(getWriterPidPath(root), olderFormat('direct'));
    expect(readWriterLock(root)?.pid).toBe(holder);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('taken');
  });

  it('rebuild.pid stays a rebuild in progress', () => {
    fs.writeFileSync(getWriterPidPath(root, 'rebuild.pid'), olderFormat('rebuild'));
    expect(isRebuildInProgress(root)).toBe(true);
  });

  it('codegraph.lock (bare pid, and pid plus a stamp without the field) stays held', () => {
    const lockFile = path.join(getCodeGraphDir(root), 'codegraph.lock');
    fs.writeFileSync(lockFile, String(holder));
    expect(() => codegraphLockOf(root).acquire()).toThrow(/locked by another process/);
    const stamp = lockStamp(root) as unknown as Record<string, unknown>;
    delete stamp[START_FIELD];
    delete stamp.pid;
    fs.writeFileSync(lockFile, `${holder}\n${JSON.stringify(stamp)}`);
    expect(() => codegraphLockOf(root).acquire()).toThrow(/locked by another process/);
    expect(isAlive(holder)).toBe(true);
  });
});

describe.runIf(posix)('dead-lock reclaim: a .takeover guard naming a live pid', () => {
  let root: string;
  let holder: number;

  beforeEach(async () => {
    root = await makeProject('cg-dlr-guard-');
    holder = await startUnrelatedHolder(0);
    // A dead holder's writer.pid, so the takeover (and its guard) is needed.
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({ pid: deadPid(), mode: 'direct', startedAt: 1 }) + '\n');
  });
  afterEach(() => {
    killStarted();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it(`older than the threshold (${STALE_GUARD_AGE_S} s) is cleared and the stale lock taken`, () => {
    const guard = plantGuard(getWriterPidPath(root), holder, STALE_GUARD_AGE_S);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('acquired');
    expect(readWriterLock(root)?.pid).toBe(process.pid);
    // The planted guard is gone (the taker's own guard is removed on release).
    expect(fs.existsSync(guard) ? fs.readFileSync(guard, 'utf8').trim() : null).not.toBe(String(holder));
    expect(isAlive(holder)).toBe(true);
  });

  it('written just now stays busy: the stale lock is not taken (regression guard)', () => {
    const guard = plantGuard(getWriterPidPath(root), holder, 0);
    expect(tryAcquireWriterLock(root, 'direct').kind).toBe('taken');
    expect(fs.readFileSync(guard, 'utf8').trim()).toBe(String(holder));
  });
});
