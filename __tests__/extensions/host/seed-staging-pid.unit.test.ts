import { describe, expect, it } from 'vitest';
import { seedStagingPid } from '../../../src/extensions/host/worktree-lifecycle/seed-staging-pid';

describe('seedStagingPid', () => {
  it.each([
    ['codegraph.db.seed-123-0a1b2c3d.tmp', 123],
    ['codegraph.db.seed-123-0a1b2c3d.tmp-wal', 123],
    ['codegraph.db.seed-123-0a1b2c3d.tmp-shm', 123],
    ['codegraph.db.seed-123-0a1b2c3d.tmp-journal', 123],
    ['codegraph.db', null],
    ['codegraph.db-wal', null],
    ['codegraph.db.seed-123-0a1b.tmpx', null],
    ['codegraph.db.seed-abc-0a1b.tmp', null],
    ['codegraph.db.seed-123-XYZ.tmp', null],
    ['x/codegraph.db.seed-1-ab.tmp', null],
    ['', null],
  ])('returns the staging pid for %j', (name, expected) => {
    expect(seedStagingPid(name)).toBe(expected);
  });
});
