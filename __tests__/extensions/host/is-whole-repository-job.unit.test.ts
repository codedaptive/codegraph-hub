import { describe, expect, it } from 'vitest';
import { isWholeRepositoryJob } from '../../../src/extensions/host/builder/is-whole-repository-job';
import type { JobKind } from '../../../src/extensions/host/builder/queue';

const cases: ReadonlyArray<readonly [JobKind, boolean]> = [
  ['cold-build', true], ['init', true], ['index', true], ['vacuum', true],
  ['sync', false], ['catch-up', false], ['watch-sync', false],
  ['seed', false], ['recover', false], ['open', false],
];

describe('isWholeRepositoryJob', () => {
  it.each(cases)('classifies %s as %s', (kind, expected) => {
    expect(isWholeRepositoryJob(kind)).toBe(expected);
  });
});
