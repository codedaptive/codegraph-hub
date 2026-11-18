import { describe, expect, it } from 'vitest';
import { rssOwner } from '../../../src/extensions/host/builder/rss-owner';
import type { RunningJob } from '../../../src/extensions/host/builder/running-job';

const short: RunningJob = { id: 1, kind: 'sync', root: '/sync', repo: '/a', lane: 'repo' };
const whole: RunningJob = { id: 2, kind: 'cold-build', root: '/cold', repo: '/a', lane: 'bypass' };
const olderWhole: RunningJob = { id: 3, kind: 'vacuum', root: '/vacuum', repo: '/b', lane: 'repo' };
const laterShort: RunningJob = { id: 4, kind: 'open', root: '/open', repo: '/b', lane: 'bypass' };

describe('rssOwner', () => {
  it('returns null for no running jobs', () => {
    expect(rssOwner([])).toBeNull();
  });

  it('charges the lowest-id whole-repository job regardless of lane or input order', () => {
    expect(rssOwner([olderWhole, laterShort, whole, short])).toEqual(whole);
    expect(rssOwner([short, whole, olderWhole, laterShort])).toEqual(whole);
  });

  it('charges the lowest-id job when none is a whole-repository job', () => {
    expect(rssOwner([laterShort, short])).toEqual(short);
  });
});
