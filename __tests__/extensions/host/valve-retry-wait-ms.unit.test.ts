import { describe, expect, it } from 'vitest';
import { valveRetryWaitMs } from '../../../src/extensions/host/builder/valve-retry-wait-ms';

describe('valveRetryWaitMs', () => {
  it.each([
    [1, 5_000], [2, 10_000], [3, 20_000], [4, 40_000],
    [5, 80_000], [6, 160_000], [7, 300_000], [8, 300_000], [1000, 300_000],
  ])('returns the capped wait for %i consecutive stops', (stops, wait) => {
    expect(valveRetryWaitMs(stops)).toBe(wait);
  });
});
