import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { ServerLockInfo } from '../../../src/mcp/daemon-paths';
import { probeServerProof } from '../../../src/extensions/host/server/probeServerProof';

// The two answers the probe's timer decides: a late byte on a busy machine changes them, so they are
// validation, not integration (the line- and close-decided cases are in probeServerProof.integration.test.ts).

const VERSION = '1.2.3-standin';
const TIMEOUT_MS = 5_000;

let home: string;
let socketPath: string;
let servers: net.Server[];
let sockets: net.Socket[];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pspv-')));
  socketPath = path.join(home, 's.sock');
  servers = [];
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  fs.rmSync(home, { recursive: true, force: true });
});

function lockInfo(): ServerLockInfo {
  return { pid: process.pid, version: VERSION, socketPath, startedAt: 1, stateDir: home, stateId: 'standin' };
}

async function startStandIn(onConnect: (socket: net.Socket) => void): Promise<void> {
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.on('error', () => {});
    onConnect(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
}

describe('probeServerProof timer answers', () => {
  it('is unproven when the server says hello and then nothing', async () => {
    await startStandIn(socket => {
      socket.write(JSON.stringify({ codegraph: VERSION, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    });
    expect(await probeServerProof(lockInfo(), TIMEOUT_MS)).toBe('unproven');
  });

  it('is no-answer when the server accepts and sends nothing', async () => {
    await startStandIn(() => {});
    expect(await probeServerProof(lockInfo(), TIMEOUT_MS)).toBe('no-answer');
  });
});
