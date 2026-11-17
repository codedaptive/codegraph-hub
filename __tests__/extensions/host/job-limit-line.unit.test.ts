import { describe, expect, it, vi } from 'vitest';
import { formatLimitLine } from '../../../src/extensions/host/builder/job-limit-line';

describe('formatLimitLine', () => {
  it('formats the exact time-limit line', () => {
    expect(formatLimitLine(
      { kind: 'cold-build', root: '/r' },
      { limit: 'time', measuredMs: 3600001, maxMs: 3600000 },
      new Date('2026-11-16T10:00:00.000Z'),
    )).toBe('2026-11-16T10:00:00.000Z job limit cold-build /r time 3600001 ms > 3600000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried');
  });

  it('formats the exact RSS-limit line', () => {
    expect(formatLimitLine(
      { kind: 'sync', root: '/other root' },
      { limit: 'rss', measuredRssMb: 8193, maxRssMb: 8192 },
      new Date('2026-11-16T10:00:00.000Z'),
    )).toBe('2026-11-16T10:00:00.000Z job limit sync /other root rss 8193 MB > 8192 MB (CODEGRAPH_BUILDER_JOB_MAX_RSS_MB); ended, not retried');
  });

  it('uses the current date when none is supplied', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
      expect(formatLimitLine({ kind: 'cold-build', root: '/r' }, { limit: 'time', measuredMs: 3600001, maxMs: 3600000 }))
        .toBe('2026-11-16T10:00:00.000Z job limit cold-build /r time 3600001 ms > 3600000 ms (CODEGRAPH_BUILDER_JOB_MAX_MS); ended, not retried');
    } finally {
      vi.useRealTimers();
    }
  });
});
