import { describe, expect, it } from 'vitest';
import { nextStart } from '../../../src/extensions/host/builder/next-start';
import type { JobLane } from '../../../src/extensions/host/builder/job-lane-type';

type Entry = { rootKeys: readonly string[] };
const entry = (...rootKeys: string[]): Entry => ({ rootKeys });

describe('nextStart', () => {
  it('returns null for empty queues', () => {
    expect(nextStart({ syncJobs: [], coldJobs: [], running: new Map() })).toBeNull();
  });

  it('chooses the first startable sync before a cold job', () => {
    expect(nextStart({ syncJobs: [entry('a'), entry('b')], coldJobs: [entry('c')], running: new Map() }))
      .toEqual({ lane: 'sync', index: 0 });
  });

  it('considers cold when the sync lane is running', () => {
    const running = new Map<JobLane, Entry>([['sync', entry('a')]]);
    expect(nextStart({ syncJobs: [entry('b')], coldJobs: [entry('c')], running }))
      .toEqual({ lane: 'cold', index: 0 });
  });

  it('skips sync entries whose roots are busy', () => {
    const running = new Map<JobLane, Entry>([['cold', entry('a')]]);
    expect(nextStart({ syncJobs: [entry('a'), entry('b'), entry('c')], coldJobs: [], running }))
      .toEqual({ lane: 'sync', index: 1 });
  });

  it('blocks the cold head on a running root', () => {
    const running = new Map<JobLane, Entry>([['sync', entry('a')]]);
    expect(nextStart({ syncJobs: [], coldJobs: [entry('a')], running })).toBeNull();
  });

  it('blocks the cold head on a waiting sync root', () => {
    const running = new Map<JobLane, Entry>([['sync', entry('other')]]);
    expect(nextStart({ syncJobs: [entry('a')], coldJobs: [entry('a')], running })).toBeNull();
  });

  it('blocks cold work while the cold lane is occupied', () => {
    const running = new Map<JobLane, Entry>([['cold', entry('a')]]);
    expect(nextStart({ syncJobs: [], coldJobs: [entry('b')], running })).toBeNull();
  });

  it('never skips a blocked cold head for a later cold job', () => {
    const running = new Map<JobLane, Entry>([['sync', entry('a')]]);
    expect(nextStart({ syncJobs: [], coldJobs: [entry('a'), entry('b')], running })).toBeNull();
  });

  it('compares every key of running, waiting, and candidate entries', () => {
    const running = new Map<JobLane, Entry>([['cold', entry('build', 'shared')]]);
    expect(nextStart({ syncJobs: [entry('target', 'shared'), entry('free', 'source')], coldJobs: [], running }))
      .toEqual({ lane: 'sync', index: 1 });
    const occupied = new Map<JobLane, Entry>([['sync', entry('running')]]);
    expect(nextStart({ syncJobs: [entry('target', 'source')], coldJobs: [entry('other', 'source')], running: occupied }))
      .toBeNull();
  });

  it('preserves lane and root exclusion when repeatedly starting generated jobs', () => {
    let random = 0x12345678;
    const next = () => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return random;
    };
    const roots = ['a', 'b', 'c', 'd'];
    for (let trial = 0; trial < 500; trial++) {
      const makeEntry = (): Entry => {
        const mask = next() >>> 28;
        return { rootKeys: roots.filter((_, index) => (mask & (1 << index)) !== 0) };
      };
      const syncJobs = Array.from({ length: next() % 4 }, makeEntry);
      const coldJobs = Array.from({ length: next() % 4 }, makeEntry);
      const running = new Map<JobLane, Entry>();
      if (trial % 3 === 1) running.set('sync', entry('a'));
      if (trial % 3 === 2) running.set('cold', entry('b'));
      for (let step = 0; step < 3; step++) {
        const choice = nextStart({ syncJobs, coldJobs, running });
        if (choice === null) break;
        expect(running.has(choice.lane)).toBe(false);
        const waiting = choice.lane === 'sync' ? syncJobs : coldJobs;
        expect(choice.index).toBeGreaterThanOrEqual(0);
        expect(choice.index).toBeLessThan(waiting.length);
        const started = waiting.splice(choice.index, 1)[0];
        expect(started).toBeDefined();
        if (started === undefined) throw new Error('nextStart chose a missing entry');
        for (const active of running.values()) {
          expect(started.rootKeys.some((key) => active.rootKeys.includes(key))).toBe(false);
        }
        running.set(choice.lane, started);
        expect(running.size).toBeLessThanOrEqual(2);
      }
    }
  });
});
