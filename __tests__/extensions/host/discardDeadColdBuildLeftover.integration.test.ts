import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discardDeadColdBuildLeftover } from '../../../src/extensions/host/worktree-lifecycle/discardDeadColdBuildLeftover';

let root: string;
let files: string[];
let child: ChildProcess | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-discard-cold-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
  const db = path.join(root, '.codegraph', 'codegraph.db');
  files = ['', '-wal', '-shm', '-journal'].map((suffix) => db + suffix);
  for (const file of files) fs.writeFileSync(file, 'unfinished');
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

describe('discardDeadColdBuildLeftover', () => {
  it('removes the database and all SQLite sidecars', () => {
    discardDeadColdBuildLeftover(root);
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps the database and sidecars while another live process holds writer.pid', () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    fs.writeFileSync(path.join(root, '.codegraph', 'writer.pid'), JSON.stringify({ pid: child.pid, mode: 'builder', startedAt: 1, root }));
    discardDeadColdBuildLeftover(root);
    for (const file of files) expect(fs.readFileSync(file, 'utf8')).toBe('unfinished');
  });
});
