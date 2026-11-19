import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { rebuildIndex } from '../../../src/extensions/host/rebuildIndex';
import { retryStoppedInit } from '../../../src/extensions/host/retryStoppedInit';
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

/**
 * How the stand-in answers a challenge: 'null' with `codegraph_proof: null`, 'wrong' with 64 '0' hex chars,
 * 'prove' with the HMAC a server holding $HOME/.codegraph/daemon.key gives (src/mcp/daemon-proof.ts daemonProof),
 * 'silent' sends not even a hello.
 */
type SquatterMode = 'silent' | 'null' | 'wrong' | 'prove';

/** An owner-only key in the sandbox HOME, as a server of this user would have made it. */
function writeSandboxDaemonKey(): string {
  const dir = path.join(stateDir, '.codegraph');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, 'daemon.key');
  fs.writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  return keyPath;
}

async function startSquatter(mode: SquatterMode = 'null'): Promise<{ child: ChildProcess; socketPath: string }> {
  const socketPath = path.join(stateDir, 'server.sock');
  const keyPath = mode === 'prove' ? writeSandboxDaemonKey() : '';
  const source = `
    const crypto = require('crypto');
    const fs = require('fs');
    const net = require('net');
    const [socketPath, version, mode, keyPath] = process.argv.slice(1);
    const proofFor = challenge => {
      if (mode === 'null') return null;
      if (mode === 'wrong') return '0'.repeat(64);
      return crypto.createHmac('sha256', fs.readFileSync(keyPath))
        .update('codegraph-daemon-proof-v1\\0' + challenge + '\\0' + socketPath).digest('hex');
    };
    net.createServer(socket => {
      socket.on('error', () => {});
      if (mode === 'silent') return;
      socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\\n');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (typeof message.codegraph_challenge === 'string') {
            socket.write(JSON.stringify({ codegraph_proof: proofFor(message.codegraph_challenge) }) + '\\n');
          }
        }
      });
    }).listen(socketPath, () => console.log('ready'));
  `;
  const child = spawn(process.execPath, ['-e', source, socketPath, CodeGraphPackageVersion, mode, keyPath], {
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
      const message = await result.then(() => '', (error: Error) => error.message);
      const realRoot = fs.realpathSync(root);
      const retry = operation === 'index' ? '`codegraph index`' : '`codegraph uninit`';
      expect(message.startsWith(`The process on ${socketPath} did not confirm that it released ${realRoot}`)).toBe(true);
      expect(message).toBe(
        `The process on ${socketPath} did not confirm that it released ${realRoot}, so it may still hold the database open. ` +
        `Run \`codegraph daemon --stop\`, then retry ${retry}. ` +
        'The stop acts only on the process the server lock (server.pid) names, ' +
        "and only when the server on the lock's socket proves it runs as this user. " +
        `If the stop does not report that it stopped the server, or ${retry} refuses again, ` +
        `find the process listening on ${socketPath}, check it is nothing you need, stop it, then retry ${retry}.`,
      );
      if (operation === 'uninit') expect(message).not.toContain('`codegraph index`');
      expect(fs.readFileSync(dbPath)).toEqual(original);
    },
  );

  it('tells a stopped init to retry init when a squatter refuses release', async () => {
    const { socketPath } = await startSquatter();
    const root = path.join(stateDir, 'project');
    const indexDir = path.join(root, '.codegraph');
    fs.mkdirSync(indexDir, { recursive: true });
    const db = new DatabaseSync(path.join(indexDir, 'codegraph.db'));
    db.exec('CREATE TABLE sentinel (value TEXT)');
    db.close();
    new EndedJobsFile(path.join(stateDir, 'builder-ended-jobs.jsonl')).append({
      root, kind: 'sync', limit: 'time', at: '2026-11-17T10:00:00Z',
    });
    const onRetry = vi.fn();
    const result = retryStoppedInit(root, {}, {
      runIndexOn: async () => false,
      loadEngine: () => import('../../../src/index'),
      onRetry,
    });
    const message = await result.then(() => '', (error: Error) => error.message);
    const realRoot = fs.realpathSync(root);
    expect(message.startsWith(`The process on ${socketPath} did not confirm that it released ${realRoot}`)).toBe(true);
    expect(message).toBe(
      `The process on ${socketPath} did not confirm that it released ${realRoot}, so it may still hold the database open. ` +
      'Run `codegraph daemon --stop`, then retry `codegraph init`. ' +
      'The stop acts only on the process the server lock (server.pid) names, ' +
      "and only when the server on the lock's socket proves it runs as this user. " +
      'If the stop does not report that it stopped the server, or `codegraph init` refuses again, ' +
      `find the process listening on ${socketPath}, check it is nothing you need, stop it, then retry \`codegraph init\`.`,
    );
    expect(message).not.toContain('`codegraph index`');
    expect(message).not.toContain('`codegraph uninit`');
    expect(onRetry).toHaveBeenCalledOnce();
  });

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

  it('reports busy for a silent squatter without signalling either process', async () => {
    const { child, socketPath } = await startSquatter('silent');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);
    children.push(other);
    if (child.pid === undefined || other.pid === undefined) throw new Error('child did not start');
    expect(child.pid).not.toBe(other.pid);
    writeLock(other.pid, socketPath);

    expect(await stopServer({ graceMs: 200 })).toEqual({
      outcome: 'busy', pid: other.pid, version: CodeGraphPackageVersion,
    });
    expect(isProcessAlive(child.pid)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(isProcessAlive(other.pid)).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    expect(fs.existsSync(socketPath)).toBe(true);
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

  it.each(['null', 'wrong'] as const)(
    'reports unproven and signals nothing when the lock pid says hello but answers the challenge with a %s proof',
    async mode => {
      const { child, socketPath } = await startSquatter(mode);
      if (child.pid === undefined) throw new Error('squatter has no pid');
      writeLock(child.pid, socketPath);
      expect(await stopServer({ graceMs: 200 })).toEqual({
        outcome: 'unproven', pid: child.pid, version: CodeGraphPackageVersion, socketPath,
      });
      await expectSquatterAlive(child, socketPath);
    },
  );

  it('stops a server that proves it runs as this user', async () => {
    const { child, socketPath } = await startSquatter('prove');
    if (child.pid === undefined) throw new Error('stand-in has no pid');
    writeLock(child.pid, socketPath);
    const exited = once(child, 'exit');
    expect(await stopServer({ graceMs: 10_000 })).toEqual({
      outcome: 'stopped', pid: child.pid, version: CodeGraphPackageVersion,
    });
    await exited;
    expect(child.signalCode).toBe('SIGTERM');
    expect(isProcessAlive(child.pid)).toBe(false);
  });
});
