import { describe, expect, it } from 'vitest';
import { stoppedIndexNote } from '../../../src/extensions/host/builder/stopped-index-note';

describe('stoppedIndexNote', () => {
  it('describes a time-limited job and the partial index on one line', () => {
    const note = stoppedIndexNote({ root: '/repo', kind: 'open', limit: 'time' });
    expect(note).not.toContain('\n');
    expect(note).toContain('/repo');
    expect(note).toContain('open');
    expect(note).toContain('partial or behind');
    expect(note).toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
    expect(note).not.toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/);
    expect(note).toContain('`codegraph index /repo`');
  });

  it('names the RSS limit rather than the time limit', () => {
    const note = stoppedIndexNote({ root: '/other', kind: 'sync', limit: 'rss' });
    expect(note).not.toContain('\n');
    expect(note).toContain('/other');
    expect(note).toContain('sync');
    expect(note).toContain('partial or behind');
    expect(note).toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_RSS_MB\b/);
    expect(note).not.toMatch(/\bCODEGRAPH_BUILDER_JOB_MAX_MS\b/);
    expect(note).toContain('`codegraph index /other`');
  });
});
