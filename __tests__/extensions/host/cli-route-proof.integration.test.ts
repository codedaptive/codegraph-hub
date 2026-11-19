import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import { getServerSocketPath } from '../../../src/mcp/daemon-paths';
import { daemonKey, daemonProof } from '../../../src/mcp/daemon-proof';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { rebuildIndex } from '../../../src/extensions/host/rebuildIndex';
import { removeIndexReleased } from '../../../src/extensions/host/uninit';
import { startFakeDaemon, type FakeDaemon, type FakeProof } from '../../fake-daemon';
import { builderRoute, openRoutedSync, startRoutedIndex, startRoutedInit } from '../../../src/extensions/host/builder/cli-route';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { stateIdentityOf } from './state-identity';

let dir: string;
let daemon: FakeDaemon | undefined;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-proof-')));
  vi.stubEnv('CODEGRAPH_STATE_DIR', dir);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function server(proof: FakeProof): Promise<FakeDaemon> {
  daemon = await startFakeDaemon({ proof, reply: () => ({ result: { routed: false, reason: 'not available' } }) });
  fs.writeFileSync(path.join(dir, 'server.pid'), JSON.stringify({
    pid: process.pid, version: CodeGraphPackageVersion, socketPath: daemon.socketPath,
    startedAt: 1, stateDir: dir, stateId: stateIdentityOf(dir),
  }));
  return daemon;
}

async function nullLineServer(phase: 'hello' | 'proof' | 'request') {
  const socketPath = getServerSocketPath();
  const key = daemonKey();
  if (!key) throw new Error('could not create sandboxed daemon key');
  const lines: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const listener = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const probe = ++connections === 1;
    if (!probe && phase === 'hello') { socket.write('null\n'); return; }
    socket.write(JSON.stringify({ codegraph: CodeGraphPackageVersion, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        lines.push(message);
        if (typeof message.codegraph_challenge === 'string') {
          if (phase === 'proof') socket.write('null\n');
          else socket.write(JSON.stringify({ codegraph_proof: daemonProof(key, message.codegraph_challenge, socketPath) }) + '\n');
        } else if (message.method) socket.write('null\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(socketPath, resolve); });
  fs.writeFileSync(path.join(dir, 'server.pid'), JSON.stringify({
    pid: process.pid, version: CodeGraphPackageVersion, socketPath,
    startedAt: 1, stateDir: dir, stateId: stateIdentityOf(dir),
  }));
  return { lines, disconnect: () => { for (const socket of sockets) socket.destroy(); }, close: () => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    listener.close(() => resolve());
  }) };
}

describe('CLI route proof before control hello', () => {
  it.each(['hello', 'proof', 'request'] as const)(
    'closes without an uncaught exception on null during %s', async phase => {
      const fake = await nullLineServer(phase);
      const uncaught: unknown[] = [];
      process.setUncaughtExceptionCaptureCallback(error => { uncaught.push(error); fake.disconnect(); });
      try {
        const route = await builderRoute();
        if (phase === 'request') {
          expect(route).not.toBeNull();
          if (route === null) return;
          await expect(route.sync(dir)).rejects.toThrow('closed the connection');
          route.close();
          expect(fake.lines).toEqual([
            { codegraph_challenge: expect.any(String) },
            { codegraph_client: 1, control: 1, pid: process.pid, hostPid: null },
            expect.objectContaining({ method: 'codegraph/indexWrite' }),
          ]);
        } else {
          expect(route).toBeNull();
          expect(fake.lines).toEqual(phase === 'hello' ? [] : [{ codegraph_challenge: expect.any(String) }]);
        }
        expect(uncaught).toEqual([]);
      } finally {
        process.setUncaughtExceptionCaptureCallback(null);
        await fake.close();
      }
    },
  );
  it.each(['other-key', 'other-path', 'null', 'none'] as const)(
    'does not route or send control metadata when proof is %s', async (proof) => {
      const fake = await server(proof);
      const route = await builderRoute();
      if (route) {
        await route.sync(dir);
        route.close();
      }
      expect(route).toBeNull();
      expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
    }, 10_000,
  );

  it('opens a route and sends the control hello after a matching proof', async () => {
    const fake = await server('valid');
    const route = await builderRoute();
    expect(route).not.toBeNull();
    if (route === null) return;
    await route.sync(dir);
    route.close();
    expect(fake.lines[0]).toEqual({ codegraph_challenge: expect.any(String) });
    expect(fake.lines[1]).toMatchObject({ codegraph_client: 1, control: 1 });
    expect(fake.lines[1]).not.toHaveProperty('challenge');
    expect(fake.lines[2]).toMatchObject({ method: 'codegraph/indexWrite' });
  });

  it.each([
    ['init', (root: string) => startRoutedInit(root, false, false)],
    ['index', (root: string) => startRoutedIndex(root, false, false)],
    ['sync', (root: string) => openRoutedSync(root)],
  ])('%s opens no route when proof is wrong', async (_name, open) => {
    const fake = await server('other-key');
    expect(await open(dir)).toBeNull();
    expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
  });

  it.each(['index', 'uninit'] as const)('%s refuses an unproven server and preserves the database', async operation => {
    const fake = await server('other-key');
    const root = path.join(dir, 'project');
    const indexDir = path.join(root, '.codegraph');
    const dbPath = path.join(indexDir, 'codegraph.db');
    fs.mkdirSync(indexDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep me');");
    db.close();
    const original = fs.readFileSync(dbPath);

    if (operation === 'index') {
      await expect(rebuildIndex(root, {}, {
        runIndexOn: async () => false,
        loadEngine: () => import('../../../src/index'),
      })).rejects.toThrow('did not confirm that it released');
    } else {
      await expect(removeIndexReleased(root, () => fs.rmSync(indexDir, { recursive: true, force: true })))
        .rejects.toThrow('did not confirm that it released');
    }
    expect(fs.readFileSync(dbPath)).toEqual(original);
    expect(fake.requests).toEqual([]);
  });
});
