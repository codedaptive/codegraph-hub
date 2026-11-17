import { describe, expect, it } from 'vitest';
import { JobEndedError } from '../../../src/extensions/host/builder/job-ended-error';

describe('JobEndedError', () => {
  it.each(['time', 'rss'] as const)('exposes the ended job and recovery guidance for a %s breach', (limit) => {
    const error = new JobEndedError('/project root', 'cold-build', limit);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('JobEndedError');
    expect(error.root).toBe('/project root');
    expect(error.kind).toBe('cold-build');
    expect(error.limit).toBe(limit);
    expect(error.message).toContain('/project root');
    expect(error.message).toContain('cold-build');
    expect(error.message).toContain('CODEGRAPH_BUILDER_JOB_MAX_MS');
    expect(error.message).toContain('CODEGRAPH_BUILDER_JOB_MAX_RSS_MB');
    expect(error.message).toContain('codegraph index');
  });
});
