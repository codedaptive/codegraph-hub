import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deadColdBuildHolder } from '../../../src/extensions/host/worktree-lifecycle/deadColdBuildHolder';

let root: string;
let lock: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dead-cold-holder-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
  lock = path.join(root, '.codegraph', 'rebuild.pid');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('child did not start');
  const pid = child.pid;
  await once(child, 'exit');
  return pid;
}

describe('deadColdBuildHolder', () => {
  it('recognizes a dead cold-build holder', async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), mode: 'cold-build', startedAt: 1 }));
    expect(deadColdBuildHolder(root)).toBe(true);
  });

  it('does not call this live cold-build holder dead', () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, mode: 'cold-build', startedAt: 1 }));
    expect(deadColdBuildHolder(root)).toBe(false);
  });

  it('does not classify a dead rebuild lease as a cold build', async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), mode: 'rebuild', startedAt: 1 }));
    expect(deadColdBuildHolder(root)).toBe(false);
  });

  it('returns false without a record', () => {
    expect(deadColdBuildHolder(root)).toBe(false);
  });

  it('returns false for a garbage record', () => {
    fs.writeFileSync(lock, 'not a lock record');
    expect(deadColdBuildHolder(root)).toBe(false);
  });

  it('returns false when the record cannot be read', () => {
    fs.mkdirSync(lock);
    expect(deadColdBuildHolder(root)).toBe(false);
  });
});
