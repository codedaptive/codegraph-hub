import { describe, expect, it } from 'vitest';
import { progressLogLine } from '../../../src/extensions/host/builder/progress-log-line';

describe('progressLogLine', () => {
  it('answers the line of a log payload', () => {
    expect(progressLogLine({ log: 'vacuum skipped /p' })).toBe('vacuum skipped /p');
  });

  it.each<unknown>([null, 'line', 7, { log: 3 }, { phase: 'parsing', current: 1 }, {}])('answers null for %j', (payload) => {
    expect(progressLogLine(payload)).toBeNull();
  });
});
