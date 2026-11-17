import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/directory', () => ({ canonicalProjectRoot: (root: string) => resolve(root) }));
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';
import { withEndedJob } from '../../../src/extensions/host/builder/ended-outcome';

const parent = { root: '/project', kind: 'sync', limit: 'time', at: '2026-11-16T10:00:00Z' } as const;
const deep = { root: '/project/sub/', kind: 'cold-build', limit: 'rss', at: '2026-11-16T10:01:00Z' } as const;

describe('withEndedJob', () => {
  beforeEach(() => endedJobs.replaceAll([parent, deep]));

  it('does not attach a vacuum mark to a none answer', () => {
    endedJobs.replaceAll([{ root: '/project', kind: 'vacuum', limit: 'time', at: '2026-11-17T10:00:00Z' }]);
    expect(withEndedJob({ kind: 'none' }, '/project')).toEqual({ kind: 'none' });
  });

  it('finds an ancestor non-vacuum mark past a vacuum mark', () => {
    endedJobs.replaceAll([parent, { root: '/project/sub', kind: 'vacuum', limit: 'time', at: '2026-11-17T10:00:00Z' }]);
    expect(withEndedJob({ kind: 'none' }, '/project/sub')).toEqual({
      kind: 'none', ended: { root: '/project', kind: 'sync', limit: 'time' },
    });
  });

  it('attaches the deepest canonical ancestor mark to none', () => {
    expect(withEndedJob({ kind: 'none', worktree: '/project' }, '/project/sub/file')).toEqual({
      kind: 'none', worktree: '/project', ended: { root: '/project/sub/', kind: 'cold-build', limit: 'rss' },
    });
  });

  it('matches a canonical root itself', () => {
    expect(withEndedJob({ kind: 'none' }, '/project/sub')).toEqual({
      kind: 'none', ended: { root: '/project/sub/', kind: 'cold-build', limit: 'rss' },
    });
  });

  it('leaves unrelated and prefix-only paths unchanged', () => {
    expect(withEndedJob({ kind: 'none' }, '/project-other')).toEqual({ kind: 'none' });
  });

  it('turns a building answer into none when its own root cold build ended', () => {
    expect(withEndedJob({ kind: 'building', root: '/project/sub' }, '/project/sub/file')).toEqual({
      kind: 'none', ended: { root: '/project/sub/', kind: 'cold-build', limit: 'rss' },
    });
  });

  it('leaves building unchanged when only an ancestor cold build ended', () => {
    expect(withEndedJob({ kind: 'building', root: '/project/sub/child' }, '/project/sub/child'))
      .toEqual({ kind: 'building', root: '/project/sub/child' });
  });

  it('leaves building unchanged for a non-cold-build mark', () => {
    expect(withEndedJob({ kind: 'building', root: '/project/other' }, '/project/other')).toEqual({ kind: 'building', root: '/project/other' });
  });

  it('leaves ready, seeded and pending none unchanged', () => {
    expect(withEndedJob({ kind: 'ready', root: '/project' }, '/project')).toEqual({ kind: 'ready', root: '/project' });
    expect(withEndedJob({ kind: 'seeded', root: '/project', source: '/source', method: 'copy' }, '/project'))
      .toEqual({ kind: 'seeded', root: '/project', source: '/source', method: 'copy' });
    expect(withEndedJob({ kind: 'none', pending: true }, '/project')).toEqual({ kind: 'none', pending: true });
  });
});
