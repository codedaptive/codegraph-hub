import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { daemonKey, daemonProof } from '../../../src/mcp/daemon-proof';
import { routeHandshakeStep } from '../../../src/extensions/host/builder/routeHandshakeStep';

const challenge = 'handshake-challenge';
const lock = { pid: 1234, version: '1.2.3', socketPath: '/socket/server', startedAt: 1, stateDir: '/state', stateId: 'state' };
const hello = { protocol: 1, codegraph: '1.2.3', pid: 1234 };
let home: string;
let key: Buffer;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-handshake-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const created = daemonKey();
  if (!created) throw new Error('could not create sandboxed daemon key');
  key = created;
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('routeHandshakeStep', () => {
  it('challenges a hello matching the lock', () => {
    expect(routeHandshakeStep('hello', hello, lock, challenge)).toEqual({
      next: 'proof', write: '{"codegraph_challenge":"handshake-challenge"}\n',
    });
  });

  it.each([
    { ...hello, protocol: 2 }, { ...hello, codegraph: 1 },
    { ...hello, codegraph: 'other' }, { ...hello, pid: 1235 }, {},
  ])('rejects a hello that does not match the lock: %j', (message) => {
    expect(routeHandshakeStep('hello', message, lock, challenge)).toBeNull();
  });

  it('opens on a proof for this challenge and socket', () => {
    const proof = daemonProof(key, challenge, lock.socketPath);
    expect(routeHandshakeStep('proof', { codegraph_proof: proof }, lock, challenge)).toEqual({
      next: 'open', write: `{"codegraph_client":1,"control":1,"pid":${process.pid},"hostPid":null}\n`,
    });
  });

  it('rejects proofs for a different key, socket or challenge', () => {
    const otherKey = Buffer.from(key.map(byte => byte ^ 0xff));
    for (const proof of [
      daemonProof(otherKey, challenge, lock.socketPath),
      daemonProof(key, challenge, '/socket/other'),
      daemonProof(key, 'other', lock.socketPath),
      null, 'not-hex',
    ]) {
      expect(routeHandshakeStep('proof', { codegraph_proof: proof }, lock, challenge)).toBeNull();
    }
  });

  it.each(['hello', 'proof'] as const)('rejects non-object messages in %s', (phase) => {
    for (const message of [null, [], 5, 'x']) {
      expect(routeHandshakeStep(phase, message, lock, challenge)).toBeNull();
    }
  });
});
