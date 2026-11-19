import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { daemonAnswerProves } from '../../../src/mcp/daemonAnswerProves';
import { daemonKey, daemonKeyPath, daemonProof } from '../../../src/mcp/daemon-proof';

let home: string;
let key: Buffer;
const challenge = 'challenge-for-this-client';
const socketPath = '/socket/this-server';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-answer-proof-')));
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

describe('daemonAnswerProves', () => {
  it('accepts the key holder’s proof for this challenge and socket', () => {
    expect(daemonAnswerProves(challenge, socketPath, daemonProof(key, challenge, socketPath))).toBe(true);
  });

  it('rejects a proof made with another key', () => {
    const otherKey = Buffer.from(key.map((byte) => byte ^ 0xff));
    expect(daemonAnswerProves(challenge, socketPath, daemonProof(otherKey, challenge, socketPath))).toBe(false);
  });

  it('rejects a proof for another socket', () => {
    expect(daemonAnswerProves(challenge, socketPath, daemonProof(key, challenge, '/socket/other'))).toBe(false);
  });

  it('rejects a proof for another challenge', () => {
    expect(daemonAnswerProves(challenge, socketPath, daemonProof(key, 'another-challenge', socketPath))).toBe(false);
  });

  it.each([null, undefined, 'not-hex'])('rejects an invalid proof %s', (proof) => {
    expect(daemonAnswerProves(challenge, socketPath, proof)).toBe(false);
  });

  it('rejects a well-formed matching proof when the key file is missing', () => {
    const proof = daemonProof(key, challenge, socketPath);
    fs.unlinkSync(daemonKeyPath());
    expect(daemonAnswerProves(challenge, socketPath, proof)).toBe(false);
  });
});
