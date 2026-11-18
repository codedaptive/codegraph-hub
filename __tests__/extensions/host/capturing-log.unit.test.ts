import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capturingLog } from '../../../src/extensions/host/builder/capturing-log';

/** A job that runs until `finish` is called, so tests decide when each capture ends. */
function heldJob(): { job: () => Promise<string>; finish: (value: string) => void } {
  let finish: (value: string) => void = () => {};
  const done = new Promise<string>((resolve) => { finish = resolve; });
  return { job: () => done, finish };
}

describe('capturingLog', () => {
  const realLog = console.log;
  let uncaptured: string[];
  let stand: typeof console.log;

  beforeEach(() => {
    uncaptured = [];
    stand = (...args: unknown[]): void => { uncaptured.push(args.join(' ')); };
    console.log = stand;
  });

  afterEach(() => {
    console.log = realLog;
  });

  it('sends formatted lines to the capture and returns the job value', async () => {
    const lines: string[] = [];
    const result = await capturingLog((line) => lines.push(line), async () => {
      console.log('[worker] %d files', 3);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(lines).toEqual(['[worker] 3 files']);
    expect(uncaptured).toEqual([]);
    expect(console.log).toBe(stand);
  });

  it.each([
    ['first started ends first', 0],
    ['last started ends first', 1],
  ])('overlapping captures restore the original when %s', async (_name, firstToEnd) => {
    const a: string[] = [];
    const b: string[] = [];
    const jobs = [heldJob(), heldJob()];
    const runs = [
      capturingLog((line) => a.push(line), jobs[0].job),
      capturingLog((line) => b.push(line), jobs[1].job),
    ];
    console.log('both');
    jobs[firstToEnd].finish('x');
    await runs[firstToEnd];
    console.log('one left');
    jobs[1 - firstToEnd].finish('y');
    await runs[1 - firstToEnd];
    console.log('none');

    expect(console.log).toBe(stand);
    expect(uncaptured).toEqual(['none']);
    const [first, second] = firstToEnd === 0 ? [a, b] : [b, a];
    expect(first).toEqual(['both']);
    expect(second).toEqual(['both', 'one left']);
  });

  it('restores the original when the job throws', async () => {
    const lines: string[] = [];
    await expect(capturingLog((line) => lines.push(line), async () => {
      console.log('before');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(lines).toEqual(['before']);
    expect(console.log).toBe(stand);
  });

  it('restores the original when the job throws while another capture is active', async () => {
    const kept: string[] = [];
    const held = heldJob();
    const running = capturingLog((line) => kept.push(line), held.job);
    await expect(capturingLog(() => {}, () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    console.log('still captured');
    held.finish('done');
    await running;
    expect(kept).toEqual(['still captured']);
    expect(console.log).toBe(stand);
  });
});
