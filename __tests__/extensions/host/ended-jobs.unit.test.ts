import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => resolve(root) }));

import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';

const cold = { root: '/a/b/', kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' } as const;
const sync = { root: '/a/b', kind: 'sync', limit: 'rss', at: '2026-11-16T10:01:00.000Z' } as const;
const other = { root: '/other', kind: 'cold-build', limit: 'rss', at: '2026-11-16T10:02:00.000Z' } as const;

describe('endedJobs', () => {
  beforeEach(() => endedJobs.replaceAll([]));

  it('finds a job by canonical root and kind', () => {
    endedJobs.add(cold);
    expect(endedJobs.has('/a/b', 'cold-build')).toBe(true);
    expect(endedJobs.find('/a/b', 'cold-build')).toMatchObject({ kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' });
    expect(endedJobs.has('/a/b', 'sync')).toBe(false);
    expect(endedJobs.find('/other', 'cold-build')).toBeUndefined();
  });

  it('clears every kind for a canonical root without clearing other roots', () => {
    endedJobs.add(cold);
    endedJobs.add(sync);
    endedJobs.add(other);
    endedJobs.clearRoot('/a/b/');
    expect(endedJobs.has('/a/b', 'cold-build')).toBe(false);
    expect(endedJobs.has('/a/b', 'sync')).toBe(false);
    expect(endedJobs.list()).toEqual([other]);
  });

  it('replaces the entire set and lists the replacements', () => {
    endedJobs.add(cold);
    endedJobs.replaceAll([sync, other]);
    expect(endedJobs.has('/a/b', 'cold-build')).toBe(false);
    expect(endedJobs.list()).toEqual(expect.arrayContaining([sync, other]));
    expect(endedJobs.list()).toHaveLength(2);
    endedJobs.replaceAll([]);
    expect(endedJobs.list()).toEqual([]);
  });
});
