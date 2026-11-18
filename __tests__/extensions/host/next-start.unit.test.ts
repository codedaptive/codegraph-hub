import { describe, expect, it } from 'vitest';
import type { JobLane } from '../../../src/extensions/host/builder/job-lane-type';
import { nextStart } from '../../../src/extensions/host/builder/next-start';
import type { JobKind } from '../../../src/extensions/host/builder/queue';

interface Job { kind: JobKind; repo: string; rootKeys: readonly string[] }

const job = (kind: JobKind, repo: string, ...rootKeys: string[]): Job => ({ kind, repo, rootKeys });
const run = (lane: JobLane, entry: Job) => ({ job: entry, lane });
const below = () => 94.9;
const at = () => 95;

describe('nextStart', () => {
  it('starts nothing when nothing waits', () => {
    expect(nextStart([], [], below)).toBeNull();
  });

  it('starts a waiting job in its repository slot when that slot is free', () => {
    expect(nextStart([job('sync', 'a', '/a1')], [], at)).toEqual({ index: 0, lane: 'repo' });
  });

  it('starts a job of another repository in its own slot beside a busy one, whatever the load', () => {
    expect(nextStart([job('cold-build', 'b', '/b1')], [run('repo', job('cold-build', 'a', '/a1'))], at))
      .toEqual({ index: 0, lane: 'repo' });
  });

  it('starts a repository\'s first waiting short job ahead of its older whole-repository job', () => {
    expect(nextStart([job('vacuum', 'a', '/a1'), job('seed', 'a', '/a2')], [], at)).toEqual({ index: 1, lane: 'repo' });
  });

  it('skips a short job whose root a running job holds for the next short job of that repository', () => {
    const waiting = [job('sync', 'a', '/a1'), job('sync', 'a', '/a2')];
    expect(nextStart(waiting, [run('repo', job('index', 'b', '/b1', '/a1'))], at)).toEqual({ index: 1, lane: 'repo' });
  });

  it('holds a whole-repository job whose root a waiting short job of its repository names', () => {
    const waiting = [job('index', 'a', '/a1'), job('seed', 'a', '/a2', '/a1')];
    expect(nextStart(waiting, [run('repo', job('sync', 'b', '/b1', '/a2'))], below)).toBeNull();
  });

  it('does not hold a whole-repository job for a waiting short job of another repository naming its root', () => {
    const waiting = [job('seed', 'b', '/b2', '/a1'), job('index', 'a', '/a1')];
    expect(nextStart(waiting, [run('repo', job('sync', 'b', '/b1', '/b2'))], at)).toEqual({ index: 1, lane: 'repo' });
  });

  it('never starts a later whole-repository job around the repository\'s oldest one', () => {
    const waiting = [job('index', 'a', '/a1'), job('init', 'a', '/a2')];
    expect(nextStart(waiting, [run('repo', job('sync', 'b', '/b1', '/a1'))], below)).toBeNull();
  });

  it('starts a busy repository\'s next job in a bypass slot only below load 95', () => {
    const running = [run('repo', job('cold-build', 'a', '/a1'))];
    expect(nextStart([job('sync', 'a', '/a2')], running, below)).toEqual({ index: 0, lane: 'bypass' });
    expect(nextStart([job('sync', 'a', '/a2')], running, at)).toBeNull();
  });

  it('starts nothing in bypass when both bypass slots are busy', () => {
    const running = [run('repo', job('cold-build', 'a', '/a1')), run('bypass', job('sync', 'a', '/a2')), run('bypass', job('sync', 'b', '/b1'))];
    expect(nextStart([job('sync', 'a', '/a3')], running, () => 0)).toBeNull();
  });

  it('gives a bypass slot to the earliest queued next job among busy repositories', () => {
    const running = [run('repo', job('sync', 'a', '/a1')), run('repo', job('sync', 'b', '/b1'))];
    expect(nextStart([job('sync', 'b', '/b2'), job('sync', 'a', '/a2')], running, below)).toEqual({ index: 0, lane: 'bypass' });
    expect(nextStart([job('sync', 'a', '/a2'), job('sync', 'b', '/b2')], running, below)).toEqual({ index: 0, lane: 'bypass' });
  });

  it('never starts a job whose root a bypass job holds', () => {
    const running = [run('bypass', job('sync', 'a', '/shared'))];
    expect(nextStart([job('sync', 'b', '/b1', '/shared')], running, below)).toBeNull();
  });
});
