import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RebuildLease } from '../../../src/extensions/host/builder/fences';
import { takeRebuildWriter } from '../../../src/extensions/host/builder/take-rebuild-writer';

let root: string;
let writerPath: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rebuild-writer-')));
  fs.mkdirSync(path.join(root, '.codegraph'));
  writerPath = path.join(root, '.codegraph', 'writer.pid');
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

describe('takeRebuildWriter', () => {
  it('takes writer.pid for the parent in rebuild mode', async () => {
    const lease = new RebuildLease(root, root, 'index');
    await takeRebuildWriter(lease, { release: async () => {} });
    expect(JSON.parse(fs.readFileSync(writerPath, 'utf8'))).toMatchObject({ pid: process.pid, mode: 'rebuild' });
  });

  it('refuses another live writer with the writer-lock message', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('child did not start');
    const pid = child.pid;
    const record = JSON.stringify({ pid, mode: 'builder', startedAt: 1, root });
    fs.writeFileSync(writerPath, record);
    const lease = new RebuildLease(root, root, 'index');
    await expect(takeRebuildWriter(lease, { release: async () => {} })).rejects.toThrow(
      `CodeGraph writer lock held by PID ${pid} (builder mode). ` +
      'Only one live MCP writer may serve a project (auto-sync / index). ' +
      'Stop the other server (if it is the shared daemon, stop it with `codegraph daemon --stop`; otherwise end the other MCP session), ' +
      'or unset CODEGRAPH_NO_DAEMON so additional clients proxy to the shared daemon. ' +
      `If that process is not a CodeGraph server, delete ${writerPath}`,
    );
    expect(fs.readFileSync(writerPath, 'utf8')).toBe(record);
  });
});
