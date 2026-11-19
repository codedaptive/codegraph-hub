import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getServerSocketPath } from '../../../src/mcp/daemon-paths';
import { daemonKey, daemonProof } from '../../../src/mcp/daemon-proof';
import { requestProjectRelease } from '../../../src/mcp/server-control';
import { stateIdentityOf } from './state-identity';

type ProofMode = 'valid' | 'other-key' | 'other-path' | 'null' | 'non-proof' | 'non-json' | 'close' | 'none' | 'null-hello' | 'null-proof' | 'null-reply';

let dir: string;
const servers: Array<{ close(): Promise<void> }> = [];
const root = '/project/private-release-root';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-proof-')));
  vi.stubEnv('CODEGRAPH_STATE_DIR', dir);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  if (!daemonKey()) throw new Error('could not create the sandboxed daemon key');
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function standIn(mode: ProofMode, socketPath = getServerSocketPath()) {
  const lines: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode === 'null-hello') { socket.write('null\n'); return; }
    socket.write(JSON.stringify({ codegraph: 'fake', pid: process.pid, socketPath, protocol: 1 }) + '\n');
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        lines.push(message);
        if (mode === 'close') { socket.end(); continue; }
        if (typeof message.codegraph_challenge === 'string') {
          if (mode === 'none') continue;
          if (mode === 'null-proof') { socket.write('null\n'); continue; }
          if (mode === 'non-proof') { socket.write('{"not_proof":true}\n'); continue; }
          if (mode === 'non-json') { socket.write('not JSON\n'); continue; }
          const key = mode === 'other-key' ? randomBytes(32) : daemonKey();
          const proofPath = mode === 'other-path' ? `${socketPath}-other` : socketPath;
          const proof = mode === 'null' || !key ? null : daemonProof(key, message.codegraph_challenge, proofPath);
          socket.write(JSON.stringify({ codegraph_proof: proof }) + '\n');
        } else if (message.method === 'codegraph/releaseProject') {
          if (mode === 'null-reply') socket.write('null\n');
          else socket.write('{"jsonrpc":"2.0","id":"release","result":{"released":true}}\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  servers.push({ close: () => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }) });
  return { lines, socketPath, disconnect: () => { for (const socket of sockets) socket.destroy(); } };
}

function writeLock(socketPath: string) {
  fs.writeFileSync(path.join(dir, 'server.pid'), JSON.stringify({
    pid: process.pid, version: 'fake', socketPath, startedAt: 1, stateDir: dir, stateId: stateIdentityOf(dir),
  }));
}

describe('project release proof before control hello', () => {
  it.each(['null-hello', 'null-proof', 'null-reply'] as const)(
    'returns failed without an uncaught exception for %s', async (mode) => {
      const fake = await standIn(mode);
      writeLock(fake.socketPath);
      const uncaught: unknown[] = [];
      process.setUncaughtExceptionCaptureCallback(error => { uncaught.push(error); fake.disconnect(); });
      try {
        expect(await requestProjectRelease(root, 1000)).toBe('failed');
        if (mode === 'null-hello') expect(fake.lines).toEqual([]);
        if (mode === 'null-proof') expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
        if (mode === 'null-reply') expect(fake.lines).toEqual([
          { codegraph_challenge: expect.any(String) },
          { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null },
          { jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root } },
        ]);
        expect(uncaught).toEqual([]);
      } finally {
        process.setUncaughtExceptionCaptureCallback(null);
      }
    },
  );
  it.each(['other-key', 'other-path', 'null', 'non-proof', 'non-json', 'close', 'none'] as const)(
    'sends only the challenge and returns failed for %s', async (mode) => {
      const fake = await standIn(mode);
      writeLock(fake.socketPath);
      const result = await requestProjectRelease(root, 300);
      expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
      expect(result).toBe('failed');
    },
  );

  it('sends the control hello and release request after a matching proof', async () => {
    const fake = await standIn('valid');
    writeLock(fake.socketPath);
    const result = await requestProjectRelease(root, 1_000);
    expect(fake.lines).toEqual([
      { codegraph_challenge: expect.any(String) },
      { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null },
      { jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root } },
    ]);
    expect(result).toBe('released');
  });

  it('returns failed without trying the next candidate after an unproven lock socket', async () => {
    const first = await standIn('other-key', `${getServerSocketPath()}-lock`);
    const second = await standIn('valid');
    writeLock(first.socketPath);
    const result = await requestProjectRelease(root, 1_000);
    expect(first.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
    expect(result).toBe('failed');
    expect(second.lines).toEqual([]);
  });
});
