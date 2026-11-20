import { describe, expect, it } from 'vitest';
import { stopOutcomeOfProof } from '../../../src/extensions/host/server/stopOutcomeOfProof';

const info = { pid: 4321, version: '1.6.2-sm.12', socketPath: '/example/state/server.sock' };

describe('stopOutcomeOfProof', () => {
  it('goes on (null) when the server proved itself', () => {
    expect(stopOutcomeOfProof('proven', info)).toBeNull();
  });

  it('is unproven and names the socket when the hello matched but the proof did not', () => {
    expect(stopOutcomeOfProof('unproven', info)).toStrictEqual({
      outcome: 'unproven', pid: 4321, version: '1.6.2-sm.12', socketPath: '/example/state/server.sock',
    });
  });

  it('is unverified, naming no socket, when what answered was not the server', () => {
    expect(stopOutcomeOfProof('mismatch', info)).toStrictEqual({
      outcome: 'unverified', pid: 4321, version: '1.6.2-sm.12',
    });
  });

  it('is busy, naming no socket, when the server said nothing in time', () => {
    expect(stopOutcomeOfProof('no-answer', info)).toStrictEqual({
      outcome: 'busy', pid: 4321, version: '1.6.2-sm.12',
    });
  });
});
