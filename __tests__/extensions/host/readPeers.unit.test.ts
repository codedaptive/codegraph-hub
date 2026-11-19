import { describe, expect, it } from 'vitest';
import { readPeers } from '../../../src/mcp/readPeers';

type Peers = { name: string };
const none: Peers = { name: 'none' };
const parseHello = (line: string): Peers | null => line === 'hello' ? { name: 'client' } : null;

function reader(lines: string[]) {
  const consumed: string[] = [];
  return {
    consumed,
    readLine: async <T>(parse: (line: string) => T | null, fallback: T): Promise<T> => {
      const line = lines.shift();
      if (line === undefined) return fallback;
      consumed.push(line);
      return parse(line) ?? fallback;
    },
  };
}

describe('readPeers', () => {
  it('returns a first-line hello without answering or reading another line', async () => {
    const input = reader(['hello', 'unused']);
    const answers: string[] = [];
    expect(await readPeers(input.readLine, parseHello, none, challenge => answers.push(challenge))).toEqual({ name: 'client' });
    expect(input.consumed).toEqual(['hello']);
    expect(answers).toEqual([]);
  });

  it('answers a challenge once and returns the next hello', async () => {
    const input = reader(['{"codegraph_challenge":"abc"}', 'hello']);
    const answers: string[] = [];
    expect(await readPeers(input.readLine, parseHello, none, challenge => answers.push(challenge))).toEqual({ name: 'client' });
    expect(input.consumed).toEqual(['{"codegraph_challenge":"abc"}', 'hello']);
    expect(answers).toEqual(['abc']);
  });

  it('returns none after a challenge followed by an invalid hello', async () => {
    const input = reader(['{"codegraph_challenge":"abc"}', 'invalid']);
    const answers: string[] = [];
    expect(await readPeers(input.readLine, parseHello, none, challenge => answers.push(challenge))).toEqual({ name: 'none' });
    expect(answers).toEqual(['abc']);
  });

  it('returns none without answering an invalid first line', async () => {
    const input = reader(['invalid', 'hello']);
    const answers: string[] = [];
    expect(await readPeers(input.readLine, parseHello, none, challenge => answers.push(challenge))).toEqual({ name: 'none' });
    expect(input.consumed).toEqual(['invalid']);
    expect(answers).toEqual([]);
  });

  it('prefers a challenge even when the hello parser also accepts it', async () => {
    const input = reader(['{"codegraph_challenge":"abc"}', 'hello']);
    const answers: string[] = [];
    expect(await readPeers(input.readLine, () => ({ name: 'accepted' }), none, challenge => answers.push(challenge))).toEqual({ name: 'accepted' });
    expect(input.consumed).toEqual(['{"codegraph_challenge":"abc"}', 'hello']);
    expect(answers).toEqual(['abc']);
  });
});
