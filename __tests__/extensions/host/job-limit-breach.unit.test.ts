import { describe, expect, it } from 'vitest';
import { checkJobLimits } from '../../../src/extensions/host/builder/job-limit-breach';

const limits = { maxMs: 1000, maxRssMb: 2 };

describe('checkJobLimits', () => {
  it('does not breach at either exact boundary', () => {
    expect(checkJobLimits(1000, 2_097_152, limits)).toBeNull();
  });

  it('reports a time breach one millisecond over', () => {
    expect(checkJobLimits(1001, 2_097_152, limits)).toEqual({ limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });

  it('reports an RSS breach one byte over even when the rounded measurement equals the limit', () => {
    expect(checkJobLimits(1000, 2_097_153, limits)).toEqual({ limit: 'rss', maxRssMb: 2, measuredRssMb: 2 });
  });

  it('rounds the measured RSS in MiB to the nearest integer', () => {
    expect(checkJobLimits(0, 2_621_440, limits)).toEqual({ limit: 'rss', maxRssMb: 2, measuredRssMb: 3 });
  });

  it('reports time first when both limits are exceeded', () => {
    expect(checkJobLimits(1001, 3_145_728, limits)).toEqual({ limit: 'time', maxMs: 1000, measuredMs: 1001 });
  });
});
