import { describe, expect, it, vi } from 'vitest';
import { runJobChild } from '../../../src/extensions/host/builder/job-child-main';

const spec = { kind: 'sync' as const, root: '/root', module: '/body.cjs', export: 'work', args: { n: 3 }, writerPid: 876 };

describe('runJobChild', () => {
  it('sends progress and database messages in order before the result and exits successfully', async () => {
    const events: unknown[] = [];
    let handler: (message: unknown) => void = () => undefined;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const channel = { send: (message: unknown) => { events.push(message); }, onMessage: (fn: (message: unknown) => void) => { handler = fn; }, exit: (code: number) => { events.push({ exit: code }); finished(); } };
    const load = vi.fn(() => ({ work: async (args: unknown, ctx: { progress: (value: unknown) => void; reportDatabase: (root: string, identity: string | null) => void; writerPid: number }) => {
      ctx.progress(args);
      ctx.reportDatabase('/root', 'db-identity');
      ctx.progress(ctx.writerPid);
      return 'done';
    } }));
    runJobChild(channel, load);
    handler({ type: 'spec', spec });
    await done;
    expect(load).toHaveBeenCalledWith('/body.cjs');
    expect(events).toEqual([
      { type: 'progress', payload: { n: 3 } },
      { type: 'database-created', root: '/root', identity: 'db-identity' },
      { type: 'progress', payload: 876 },
      { type: 'result', value: 'done' },
      { exit: 0 },
    ]);
  });

  it.each(['throw', 'reject'])('sends an error and exits unsuccessfully on %s', async (mode) => {
    const events: unknown[] = [];
    let handler: (message: unknown) => void = () => undefined;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const channel = { send: (message: unknown) => { events.push(message); }, onMessage: (fn: (message: unknown) => void) => { handler = fn; }, exit: (code: number) => { events.push({ exit: code }); finished(); } };
    runJobChild(channel, () => ({ work: () => { if (mode === 'throw') throw new Error('broken'); return Promise.reject(new Error('broken')); } }));
    handler({ type: 'spec', spec });
    await done;
    expect(events).toEqual([{ type: 'error', message: 'broken' }, { exit: 1 }]);
  });

  it('names a missing export and exits unsuccessfully', async () => {
    const events: unknown[] = [];
    let handler: (message: unknown) => void = () => undefined;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const channel = { send: (message: unknown) => { events.push(message); }, onMessage: (fn: (message: unknown) => void) => { handler = fn; }, exit: (code: number) => { events.push({ exit: code }); finished(); } };
    runJobChild(channel, () => ({}));
    handler({ type: 'spec', spec });
    await done;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('work') });
    expect(events[1]).toEqual({ exit: 1 });
  });
});
