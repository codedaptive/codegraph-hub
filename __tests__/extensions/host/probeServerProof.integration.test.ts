import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { ServerLockInfo } from '../../../src/mcp/daemon-paths';
import { daemonProof } from '../../../src/mcp/daemon-proof';
import { probeServerProof } from '../../../src/extensions/host/server/probeServerProof';

const VERSION = '1.2.3-standin';
/** Wider than any test runs, so a line or a close decides every case here, never the probe's timer. */
const WIDE_MS = 30_000;

let home: string;
let socketPath: string;
let servers: net.Server[];
let sockets: net.Socket[];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-psp-')));
  socketPath = path.join(home, 's.sock');
  servers = [];
  sockets = [];
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** An owner-only key in the sandbox HOME, as a server of this user would have made it. */
function writeSandboxDaemonKey(): Buffer {
  const dir = path.join(home, '.codegraph');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  fs.writeFileSync(path.join(dir, 'daemon.key'), key, { mode: 0o600 });
  return key;
}

function lockInfo(pid = process.pid): ServerLockInfo {
  return { pid, version: VERSION, socketPath, startedAt: 1, stateDir: home, stateId: 'standin' };
}

function helloLine({ pid = process.pid, codegraph = VERSION, protocol = 1 } = {}): string {
  return JSON.stringify({ codegraph, pid, socketPath, protocol }) + '\n';
}

/** A stand-in on `socketPath` that runs `onConnect` for each connection and records every byte it receives. */
async function startStandIn(onConnect: (socket: net.Socket) => void): Promise<{ received: () => string }> {
  let received = '';
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', chunk => { received += chunk.toString('utf8'); });
    onConnect(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return { received: () => received };
}

/** After `hello`, answer the first challenge line with `{codegraph_proof: proofFor(challenge)}`. */
function answeringStandIn(proofFor: (challenge: string) => unknown, hello = helloLine()): (socket: net.Socket) => void {
  return socket => {
    socket.write(hello);
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const { codegraph_challenge: challenge } = JSON.parse(buffer.slice(0, newline)) as { codegraph_challenge: string };
      socket.write(JSON.stringify({ codegraph_proof: proofFor(challenge) }) + '\n');
    });
  };
}

describe('probeServerProof', () => {
  it('is proven when the server answers the challenge with this user\'s proof for its socket', async () => {
    const key = writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(challenge => daemonProof(key, challenge, socketPath)));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('proven');
  });

  it('is unproven for a null proof', async () => {
    writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(() => null));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('unproven');
  });

  it('is unproven for a wrong proof', async () => {
    writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(() => '0'.repeat(64)));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('unproven');
  });

  it('is unproven for a proof made for another socket path', async () => {
    const key = writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(challenge => daemonProof(key, challenge, '/elsewhere/s.sock')));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('unproven');
  });

  it('is unproven when the server says hello and closes once it has the challenge', async () => {
    writeSandboxDaemonKey();
    await startStandIn(socket => {
      socket.write(helloLine());
      socket.once('data', () => socket.end());
    });
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('unproven');
  });

  it('is a mismatch when the hello names another pid', async () => {
    writeSandboxDaemonKey();
    await startStandIn(socket => { socket.write(helloLine({ pid: process.pid + 1 })); });
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('mismatch');
  });

  it('is a mismatch when the hello names the lock\'s pid and protocol 1 but another version, even with a valid proof', async () => {
    const key = writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(
      challenge => daemonProof(key, challenge, socketPath),
      helloLine({ codegraph: '9.9.9-other' }),
    ));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('mismatch');
  });

  it('is a mismatch when the hello names the lock\'s pid and version but protocol 2, even with a valid proof', async () => {
    const key = writeSandboxDaemonKey();
    await startStandIn(answeringStandIn(
      challenge => daemonProof(key, challenge, socketPath),
      helloLine({ protocol: 2 }),
    ));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('mismatch');
  });

  it('is a mismatch when the first line is not JSON', async () => {
    writeSandboxDaemonKey();
    await startStandIn(socket => { socket.write('not json\n'); });
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('mismatch');
  });

  it('sends exactly one line after a matching hello: only a string codegraph_challenge', async () => {
    writeSandboxDaemonKey();
    const standIn = await startStandIn(answeringStandIn(() => null));
    expect(await probeServerProof(lockInfo(), WIDE_MS)).toBe('unproven');
    // Read only once the probe has closed its end, so a line it sent after the proof is counted too.
    const [socket] = sockets;
    if (!socket.closed) await new Promise(resolve => socket.once('close', resolve));
    const lines = standIn.received().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    const message = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(['codegraph_challenge']);
    expect(typeof message.codegraph_challenge).toBe('string');
    expect(message.codegraph_challenge).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
