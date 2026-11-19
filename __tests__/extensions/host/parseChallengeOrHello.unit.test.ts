import { describe, expect, it } from 'vitest';
import { parseChallengeOrHello } from '../../../src/mcp/parseChallengeOrHello';

const challengeLine = '{"codegraph_challenge":"abc"}';
const parseHello = (line: string) => line === 'hello' || line === challengeLine
  ? { hello: 'accepted' }
  : null;

describe('parseChallengeOrHello', () => {
  it('returns the challenge from a challenge line', () => {
    expect(parseChallengeOrHello(challengeLine, () => null)).toEqual({ challenge: 'abc' });
  });

  it('returns the hello parser value when the line is not a challenge', () => {
    expect(parseChallengeOrHello('hello', parseHello)).toEqual({ hello: 'accepted' });
  });

  it('returns null when neither parser accepts the line', () => {
    expect(parseChallengeOrHello('unrecognized', parseHello)).toBeNull();
  });

  it('prefers the challenge when the hello parser also accepts the line', () => {
    expect(parseChallengeOrHello(challengeLine, parseHello)).toEqual({ challenge: 'abc' });
  });
});
