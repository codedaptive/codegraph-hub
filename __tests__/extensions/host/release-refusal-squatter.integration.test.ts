import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { rebuildIndex } from '../../../src/extensions/host/rebuildIndex';
import { removeIndexReleased } from '../../../src/extensions/host/uninit';
import { encodeServerLock } from '../../../src/mcp/daemon-paths';
import { isProcessAlive, requestProjectRelease, stopServer } from '../../../src/mcp/server-control';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { stateIdentityOf } from './state-identity';

let stateDir: string;
let children: ChildProcess[];

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-squat-')));
  children = [];
  vi.stubEnv('CODEGRAPH_STATE_DIR', stateDir);
  vi.stubEnv('HOME', stateDir);
  vi.stubEnv('USERPROFILE', stateDir);
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function startSquatter(): Promise<{ child: ChildProcess; socketPath: string }> {
  const socketPath = path.join(stateDir, 'server.sock');
  const source = `
    const net = require('net');
    const socketPath = process.argv[1];
    const version = process.argv[2];
    net.createServer(socket => {
      socket.on('error', () => {});
      socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\\n');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (typeof message.codegraph_challenge === 'string') {
            socket.write(JSON.stringify({ codegraph_proof: null }) + '\\n');
          }
        }
      });
    }).listen(socketPath, () => console.log('ready'));
  `;
  const child = spawn(process.execPath, ['-e', source, socketPath, CodeGraphPackageVersion], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  if (child.pid === undefined || child.stdout === null) throw new Error('squatter did not start');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('squatter exited before listening')));
    child.stdout?.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
  });
  return { child, socketPath };
}

function writeLock(pid: number, socketPath: string): void {
  fs.writeFileSync(path.join(stateDir, 'server.pid'), encodeServerLock({
    pid, version: CodeGraphPackageVersion, socketPath, startedAt: 1,
    stateDir, stateId: stateIdentityOf(stateDir),
  }));
}

async function expectSquatterAlive(child: ChildProcess, socketPath: string): Promise<void> {
  if (child.pid === undefined) throw new Error('squatter has no pid');
  expect(isProcessAlive(child.pid)).toBe(true);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(fs.existsSync(socketPath)).toBe(true);
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  let buffer = '';
  const hello = await new Promise<string>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(buffer.slice(0, buffer.indexOf('\n')));
    });
  });
  socket.destroy();
  expect(JSON.parse(hello)).toEqual({
    codegraph: CodeGraphPackageVersion, pid: child.pid, socketPath, protocol: 1,
  });
}

describe('unproven release from a socket squatter', () => {
  it.each(['index', 'uninit'] as const)(
    '%s names the failed socket and preserves the database', async operation => {
      const { socketPath } = await startSquatter();
      const root = path.join(stateDir, 'project');
      const indexDir = path.join(root, '.codegraph');
      const dbPath = path.join(indexDir, 'codegraph.db');
      fs.mkdirSync(indexDir, { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep me');");
      db.close();
      const original = fs.readFileSync(dbPath);
      const result = operation === 'index'
        ? rebuildIndex(root, {}, {
          runIndexOn: async () => false,
          loadEngine: () => import('../../../src/index'),
        })
        : removeIndexReleased(root, () => fs.rmSync(indexDir, { recursive: true, force: true }));
      await expect(result).rejects.toThrow('did not confirm that it released');
      expect(fs.readFileSync(dbPath)).toEqual(original);
      await expect(result).rejects.toThrow('`codegraph daemon --stop`');
      await expect(result).rejects.toThrow(socketPath);
    },
  );

  it('reports the socket path of the failed release attempt to the callback', async () => {
    const { socketPath } = await startSquatter();
    const failedPaths: string[] = [];
    const result = await Reflect.apply(requestProjectRelease, undefined, [
      stateDir, 1000, (failedPath: string) => failedPaths.push(failedPath),
    ]);
    expect(result).toBe('failed');
    expect(failedPaths).toEqual([socketPath]);
  });

  it('does not signal a squatter when no lock exists', async () => {
    const { child, socketPath } = await startSquatter();
    expect(await stopServer({ graceMs: 200 })).toEqual({ outcome: 'not-running' });
    await expectSquatterAlive(child, socketPath);
  });

  it('does not signal a squatter when the lock names a dead pid', async () => {
    const { child, socketPath } = await startSquatter();
    const dead = spawn(process.execPath, ['-e', '']);
    children.push(dead);
    if (dead.pid === undefined) throw new Error('dead child did not start');
    await once(dead, 'exit');
    writeLock(dead.pid, socketPath);
    expect(await stopServer({ graceMs: 200 })).toEqual({
      outcome: 'not-running', pid: dead.pid, version: CodeGraphPackageVersion,
    });
    await expectSquatterAlive(child, socketPath);
  });

  it('does not signal either process when a live lock pid is not the socket holder', async () => {
    const { child, socketPath } = await startSquatter();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);
    children.push(other);
    if (other.pid === undefined) throw new Error('other child did not start');
    writeLock(other.pid, socketPath);
    expect(await stopServer({ graceMs: 200 })).toEqual({
      outcome: 'unverified', pid: other.pid, version: CodeGraphPackageVersion,
    });
    expect(isProcessAlive(other.pid)).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    await expectSquatterAlive(child, socketPath);
  });
});
