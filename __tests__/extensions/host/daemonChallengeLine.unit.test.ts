import { describe, expect, it } from 'vitest';
import { daemonChallengeLine } from '../../../src/mcp/daemonChallengeLine';
import { parseDaemonChallengeLine } from '../../../src/mcp/parseDaemonChallengeLine';

describe('daemonChallengeLine', () => {
  it('writes only the challenge and a newline', () => {
    expect(daemonChallengeLine('abc')).toBe('{"codegraph_challenge":"abc"}\n');
  });

  it('round trips valid challenges including escaped characters and the length boundary', () => {
    for (const challenge of ['x', 'quote"\\\n', 'x'.repeat(256)]) {
      expect(parseDaemonChallengeLine(daemonChallengeLine(challenge))).toBe(challenge);
    }
  });
});
