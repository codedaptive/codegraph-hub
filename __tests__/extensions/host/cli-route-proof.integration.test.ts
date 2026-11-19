import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startFakeDaemon, type FakeDaemon, type FakeProof } from '../../fake-daemon';
import { builderRoute, openRoutedSync, startRoutedIndex, startRoutedInit } from '../../../src/extensions/host/builder/cli-route';
import { CodeGraphPackageVersion } from '../../../src/mcp/version';
import { stateIdentityOf } from './state-identity';

let dir: string;
let daemon: FakeDaemon | undefined;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-proof-')));
  vi.stubEnv('CODEGRAPH_STATE_DIR', dir);
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

describe('CLI route proof before control hello', () => {
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
  ])('%s falls back when proof is wrong', async (_name, open) => {
    const fake = await server('other-key');
    expect(await open(dir)).toBeNull();
    expect(fake.lines).toEqual([{ codegraph_challenge: expect.any(String) }]);
  });
});
