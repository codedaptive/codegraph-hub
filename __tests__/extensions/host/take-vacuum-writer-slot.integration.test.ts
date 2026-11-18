import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takeVacuumWriterSlot } from '../../../src/extensions/host/builder/take-vacuum-writer-slot';
import { getWriterPidPath, readWriterLock, tryAcquireWriterLock } from '../../../src/mcp/writer-lock';

let root: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vacuum-slot-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => { child?.once('exit', () => resolve()); });
    child.kill();
    await exited;
  }
  child = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('takeVacuumWriterSlot', () => {
  it('takes an absent slot in builder mode and releases it', () => {
    const slot = takeVacuumWriterSlot(root, process.pid);
    expect(slot.kind).toBe('held');
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    if (slot.kind !== 'held') throw new Error('slot not held');
    slot.release();
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('leaves a live child writer record untouched and reports its holder', () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    const pid = child.pid;
    const record = JSON.stringify({ pid, mode: 'watch', startedAt: Date.now() }) + '\n';
    fs.writeFileSync(getWriterPidPath(root), record);
    const slot = takeVacuumWriterSlot(root, process.pid);
    expect(slot).toMatchObject({ kind: 'busy', holder: { pid } });
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
  });

  it('retains the builder owner record, including its file identity, on release', () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    const pid = child.pid;
    const record = JSON.stringify({ pid, mode: 'builder', startedAt: 1 }) + '\n';
    const pidPath = getWriterPidPath(root);
    fs.writeFileSync(pidPath, record);
    const inode = fs.statSync(pidPath).ino;
    const slot = takeVacuumWriterSlot(root, pid);
    expect(slot.kind).toBe('held');
    if (slot.kind !== 'held') throw new Error('slot not held');
    slot.release();
    expect(fs.readFileSync(pidPath, 'utf8')).toBe(record);
    expect(fs.statSync(pidPath).ino).toBe(inode);
    expect(readWriterLock(root)?.pid).toBe(pid);
  });

  it('retains an existing same-process writer record on release', () => {
    expect(tryAcquireWriterLock(root, 'builder').kind).toBe('acquired');
    const record = fs.readFileSync(getWriterPidPath(root), 'utf8');
    const slot = takeVacuumWriterSlot(root, process.pid);
    expect(slot.kind).toBe('held');
    if (slot.kind !== 'held') throw new Error('slot not held');
    slot.release();
    expect(fs.readFileSync(getWriterPidPath(root), 'utf8')).toBe(record);
    expect(readWriterLock(root)?.pid).toBe(process.pid);
  });

  it('takes a dead writer record and releases its replacement', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    const pid = child.pid;
    const exited = new Promise<void>((resolve) => { child?.once('exit', () => resolve()); });
    child.kill();
    await exited;
    fs.writeFileSync(getWriterPidPath(root), JSON.stringify({ pid, mode: 'watch', startedAt: 1 }) + '\n');
    const slot = takeVacuumWriterSlot(root, process.pid);
    expect(slot.kind).toBe('held');
    expect(readWriterLock(root)).toMatchObject({ pid: process.pid, mode: 'builder' });
    if (slot.kind !== 'held') throw new Error('slot not held');
    slot.release();
    expect(fs.existsSync(getWriterPidPath(root))).toBe(false);
  });

  it('reports an unreadable lock as busy without removing it', () => {
    fs.mkdirSync(getWriterPidPath(root));
    const slot = takeVacuumWriterSlot(root, process.pid);
    expect(slot).toEqual({ kind: 'busy', holder: null });
    expect(fs.statSync(getWriterPidPath(root)).isDirectory()).toBe(true);
  });
});
