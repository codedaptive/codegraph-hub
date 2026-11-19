import { describe, expect, it } from 'vitest';
import { parseDaemonChallengeLine } from '../../../src/mcp/parseDaemonChallengeLine';

describe('parseDaemonChallengeLine', () => {
  it('accepts a challenge-only object', () => {
    expect(parseDaemonChallengeLine('{"codegraph_challenge":"hello"}')).toBe('hello');
  });

  it.each([
    ['empty', '{"codegraph_challenge":""}'],
    ['too long', JSON.stringify({ codegraph_challenge: 'x'.repeat(257) })],
    ['number', '{"codegraph_challenge":5}'],
    ['null value', '{"codegraph_challenge":null}'],
    ['invalid JSON', 'not JSON'],
    ['client hello', '{"codegraph_client":1,"pid":7}'],
    ['array', '["hello"]'],
    ['null', 'null'],
  ])('rejects %s', (_name, line) => {
    expect(parseDaemonChallengeLine(line)).toBeNull();
  });
});
