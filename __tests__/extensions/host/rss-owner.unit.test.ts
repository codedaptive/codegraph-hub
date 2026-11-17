import { describe, expect, it } from 'vitest';
import { rssOwner } from '../../../src/extensions/host/builder/rss-owner';
import type { RunningJob } from '../../../src/extensions/host/builder/running-job';

const sync: RunningJob = { id: 1, kind: 'sync', root: '/sync', lane: 'sync' };
const cold: RunningJob = { id: 2, kind: 'cold-build', root: '/cold', lane: 'cold' };

describe('rssOwner', () => {
  it('returns null for no running jobs', () => {
    expect(rssOwner([])).toBeNull();
  });

  it('charges a lone sync job', () => {
    expect(rssOwner([sync])).toEqual({ id: 1, kind: 'sync', root: '/sync', lane: 'sync' });
  });

  it('charges a lone cold job', () => {
    expect(rssOwner([cold])).toEqual({ id: 2, kind: 'cold-build', root: '/cold', lane: 'cold' });
  });

  it.each([[sync, cold], [cold, sync]])('charges the cold job in either order', (first, second) => {
    expect(rssOwner([first, second])).toEqual({ id: 2, kind: 'cold-build', root: '/cold', lane: 'cold' });
  });
});
