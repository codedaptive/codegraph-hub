import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveJobLimits } from '../../../src/extensions/host/builder/job-limits';

describe('resolveJobLimits', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the documented defaults for unset and blank variables', () => {
    expect(resolveJobLimits({})).toEqual({ limits: { maxMs: 3_600_000, maxRssMb: 8192 }, warnings: [] });
    expect(resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: '  ', CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: '' }))
      .toEqual({ limits: { maxMs: 3_600_000, maxRssMb: 8192 }, warnings: [] });
  });

  it('uses trimmed positive integer overrides independently', () => {
    expect(resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: ' 0123 ', CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: '\t456\n' }))
      .toEqual({ limits: { maxMs: 123, maxRssMb: 456 }, warnings: [] });
    expect(resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: '42' }))
      .toEqual({ limits: { maxMs: 42, maxRssMb: 8192 }, warnings: [] });
    expect(resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: '24' }))
      .toEqual({ limits: { maxMs: 3_600_000, maxRssMb: 24 }, warnings: [] });
  });

  it('reads process.env when no environment is passed', () => {
    vi.stubEnv('CODEGRAPH_BUILDER_JOB_MAX_MS', '700');
    vi.stubEnv('CODEGRAPH_BUILDER_JOB_MAX_RSS_MB', '800');
    expect(resolveJobLimits()).toEqual({ limits: { maxMs: 700, maxRssMb: 800 }, warnings: [] });
  });

  it.each(['abc', '0', '-5', '1.5', '1e3', '  abc  '])('warns with the raw invalid time value %j without discarding the valid RSS override', (raw) => {
    const result = resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: raw, CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: '42' });
    expect(result.limits).toEqual({ maxMs: 3_600_000, maxRssMb: 42 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(result.warnings[0]).toContain(raw);
  });

  it.each(['abc', '0', '-5', '1.5', '1e3', '  abc  '])('warns with the raw invalid RSS value %j without discarding the valid time override', (raw) => {
    const result = resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: '42', CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: raw });
    expect(result.limits).toEqual({ maxMs: 42, maxRssMb: 8192 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_RSS_MB');
    expect(result.warnings[0]).toContain(raw);
  });

  it.each(['99999999999999999999', '9007199254740993'])('refuses the time value %j past Number.MAX_SAFE_INTEGER with one warning', (raw) => {
    const result = resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: raw });
    expect(result.limits).toEqual({ maxMs: 3_600_000, maxRssMb: 8192 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(result.warnings[0]).toContain(raw);
  });

  it.each(['99999999999999999999', '9007199254740993'])('refuses the RSS value %j past Number.MAX_SAFE_INTEGER with one warning', (raw) => {
    const result = resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: raw });
    expect(result.limits).toEqual({ maxMs: 3_600_000, maxRssMb: 8192 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('CODEGRAPH_BUILDER_JOB_MAX_RSS_MB');
    expect(result.warnings[0]).toContain(raw);
  });

  it('reports one warning for each independently invalid variable', () => {
    const result = resolveJobLimits({ CODEGRAPH_BUILDER_JOB_MAX_MS: '-5', CODEGRAPH_BUILDER_JOB_MAX_RSS_MB: 'abc' });
    expect(result.limits).toEqual({ maxMs: 3_600_000, maxRssMb: 8192 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_BUILDER_JOB_MAX_MS') && warning.includes('-5'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_BUILDER_JOB_MAX_RSS_MB') && warning.includes('abc'))).toBe(true);
  });
});
