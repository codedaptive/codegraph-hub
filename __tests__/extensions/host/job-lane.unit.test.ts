import { describe, expect, it } from 'vitest';
import { jobLane } from '../../../src/extensions/host/builder/job-lane';
import type { JobKind } from '../../../src/extensions/host/builder/queue';
import type { JobLane } from '../../../src/extensions/host/builder/job-lane-type';

const lanes: ReadonlyArray<readonly [JobKind, JobLane]> = [
  ['cold-build', 'cold'], ['init', 'cold'], ['index', 'cold'],
  ['sync', 'sync'], ['catch-up', 'sync'], ['watch-sync', 'sync'],
  ['seed', 'sync'], ['recover', 'sync'], ['open', 'sync'],
];

describe('jobLane', () => {
  it.each(lanes)('maps %s to %s', (kind, lane) => {
    expect(jobLane(kind)).toBe(lane);
  });
});
