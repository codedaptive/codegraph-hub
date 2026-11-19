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

type ProofMode = 'valid' | 'other-key' | 'other-path' | 'null' | 'non-proof' | 'close' | 'none';

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
          if (mode === 'non-proof') { socket.write('{"not_proof":true}\n'); continue; }
          const key = mode === 'other-key' ? randomBytes(32) : daemonKey();
          const proofPath = mode === 'other-path' ? `${socketPath}-other` : socketPath;
          const proof = mode === 'null' || !key ? null : daemonProof(key, message.codegraph_challenge, proofPath);
          socket.write(JSON.stringify({ codegraph_proof: proof }) + '\n');
        } else if (message.method === 'codegraph/releaseProject') {
          socket.write('{"jsonrpc":"2.0","id":"release","result":{"released":true}}\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  servers.push({ close: () => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }) });
  return { lines, socketPath };
}

function writeLock(socketPath: string) {
  fs.writeFileSync(path.join(dir, 'server.pid'), JSON.stringify({
    pid: process.pid, version: 'fake', socketPath, startedAt: 1, stateDir: dir, stateId: stateIdentityOf(dir),
  }));
}

describe('project release proof before control hello', () => {
  it.each(['other-key', 'other-path', 'null', 'non-proof', 'close', 'none'] as const)(
    'sends only the challenge and returns no-server for %s', async (mode) => {
      const fake = await standIn(mode);
      writeLock(fake.socketPath);
      const result = await requestProjectRelease(root, 300);
      expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
      expect(result).toBe('no-server');
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

  it('tries the next candidate after an unproven lock socket', async () => {
    const first = await standIn('other-key', `${getServerSocketPath()}-lock`);
    const second = await standIn('valid');
    writeLock(first.socketPath);
    const result = await requestProjectRelease(root, 1_000);
    expect(first.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
    expect(second.lines).toEqual([
      { codegraph_challenge: expect.any(String) },
      { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null },
      { jsonrpc: '2.0', id: 'release', method: 'codegraph/releaseProject', params: { root } },
    ]);
    expect(result).toBe('released');
  });
});
