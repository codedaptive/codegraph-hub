import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRegisteredProject, registerProject, registryDir } from '../../../src/extensions/host/worktree-lifecycle/project-registry';

describe('record lock takeover', () => {
  let tempDir: string;
  let root: string;
  let lockPath: string;
  let savedStateDir: string | undefined;
  let now: number;

  beforeEach(() => {
    savedStateDir = process.env.CODEGRAPH_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-lock-takeover-'));
    process.env.CODEGRAPH_STATE_DIR = path.join(tempDir, 'state');
    root = path.join(tempDir, 'project');
    fs.mkdirSync(root);
    registerProject(root);
    const record = fs.readdirSync(registryDir()).filter((name) => name.endsWith('.json'))[0];
    lockPath = path.join(registryDir(), `${record}.lock`);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedStateDir === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = savedStateDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function releaseAfter(delay: number): () => boolean {
    const start = now;
    const body = fs.readFileSync(lockPath, 'utf8');
    let released = false;
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      now += timeout ?? 0;
      if (now - start >= delay && !released) {
        released = fs.readFileSync(lockPath, 'utf8') === body;
        fs.unlinkSync(lockPath);
      }
      return 'timed-out';
    });
    return () => released;
  }

  it('does not take an old lock from a live process', () => {
    fs.writeFileSync(lockPath, `${process.ppid}\n${new Date(now - 3_600_000).toISOString()}`);
    const released = releaseAfter(300);
    const rec = registerProject(root, { seedNonce: 'after-release' });
    expect(released()).toBe(true);
    expect(rec.seedNonce).toBe('after-release');
    expect(getRegisteredProject(root)?.seedNonce).toBe('after-release');
  });

  it('does not take a live process lock with an invalid timestamp, even if the file is old', () => {
    fs.writeFileSync(lockPath, `${process.ppid}\nnot-a-date`);
    fs.utimesSync(lockPath, new Date(now - 3_600_000), new Date(now - 3_600_000));
    const released = releaseAfter(300);
    const rec = registerProject(root, { seedNonce: 'after-release' });
    expect(released()).toBe(true);
    expect(rec.seedNonce).toBe('after-release');
  });

  it('takes a dead process lock immediately', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    fs.writeFileSync(lockPath, `${child.pid}\n${new Date(now).toISOString()}`);
    vi.spyOn(Atomics, 'wait');
    expect(registerProject(root, { seedNonce: 'reclaimed' }).seedNonce).toBe('reclaimed');
    expect(Atomics.wait).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('takes a dead process lock immediately even with an invalid timestamp', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    fs.writeFileSync(lockPath, `${child.pid}\nnot-a-date`);
    const released = releaseAfter(300);
    expect(registerProject(root, { seedNonce: 'dead-leftover' }).seedNonce).toBe('dead-leftover');
    expect(released()).toBe(false);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  it('takes its own leftover lock immediately', () => {
    fs.writeFileSync(lockPath, `${process.pid}\n${new Date(now).toISOString()}`);
    const released = releaseAfter(300);
    expect(registerProject(root, { seedNonce: 'own-leftover' }).seedNonce).toBe('own-leftover');
    expect(released()).toBe(false);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  it('takes its own leftover lock immediately, even with an invalid timestamp', () => {
    fs.writeFileSync(lockPath, `${process.pid}\nnot-a-date`);
    const released = releaseAfter(300);
    expect(registerProject(root, { seedNonce: 'own-leftover' }).seedNonce).toBe('own-leftover');
    expect(released()).toBe(false);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  it('waits for a fresh lock without a parseable pid', () => {
    fs.writeFileSync(lockPath, '');
    const released = releaseAfter(300);
    expect(registerProject(root, { seedNonce: 'after-empty-lock' }).seedNonce).toBe('after-empty-lock');
    expect(released()).toBe(true);
  });

  it('takes an old lock without a parseable pid immediately', () => {
    fs.writeFileSync(lockPath, 'not-a-pid\n');
    fs.utimesSync(lockPath, new Date(now - 3_600_000), new Date(now - 3_600_000));
    vi.spyOn(Atomics, 'wait');
    expect(registerProject(root, { seedNonce: 'old-empty-lock' }).seedNonce).toBe('old-empty-lock');
    expect(Atomics.wait).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('waits through a three-second live hold and succeeds after release', () => {
    fs.writeFileSync(lockPath, `${process.ppid}\n${new Date(now).toISOString()}`);
    const released = releaseAfter(3_000);
    let result: ReturnType<typeof registerProject> | undefined;
    expect(() => { result = registerProject(root, { seedNonce: 'long-hold' }); }).not.toThrow();
    expect(released()).toBe(true);
    expect(result?.seedNonce).toBe('long-hold');
  });

  it('throws after about thirty seconds when a live holder never releases', () => {
    const body = `${process.ppid}\n${new Date(now).toISOString()}`;
    fs.writeFileSync(lockPath, body);
    const start = now;
    vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      now += timeout ?? 0;
      return 'timed-out';
    });
    expect(() => registerProject(root)).toThrow('locked by another process');
    expect(now - start).toBeGreaterThanOrEqual(29_000);
    expect(now - start).toBeLessThanOrEqual(31_000);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(body);
  });
});
