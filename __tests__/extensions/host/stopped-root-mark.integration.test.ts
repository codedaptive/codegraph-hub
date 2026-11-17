import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { stoppedRootMark } from '../../../src/extensions/host/builder/stopped-root-mark';

let dir: string;
let root: string;
let other: string;
let file: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stopped-mark-')));
  root = path.join(dir, 'repo');
  other = path.join(dir, 'other');
  file = path.join(dir, 'builder-ended-jobs.jsonl');
  fs.mkdirSync(root);
  fs.mkdirSync(other);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('stoppedRootMark', () => {
  it('returns the last matching line in file order using canonical paths', () => {
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    const journal = new EndedJobsFile(file);
    journal.append({ root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' });
    journal.append({ root: other, kind: 'sync', limit: 'rss', at: '2026-11-17T12:00:00Z' });
    journal.append({ root: alias, kind: 'catch-up', limit: 'rss', at: '2026-11-17T09:00:00Z' });
    expect(stoppedRootMark(path.join(root, '.'), dir)).toEqual({
      root: alias, kind: 'catch-up', limit: 'rss', at: '2026-11-17T09:00:00Z',
    });
  });

  it('returns null for a root not named by any line', () => {
    new EndedJobsFile(file).append({ root: other, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' });
    expect(stoppedRootMark(root, dir)).toBeNull();
  });

  it('returns null when the file is missing', () => {
    expect(stoppedRootMark(root, dir)).toBeNull();
  });

  it('returns null when the state directory is missing', () => {
    expect(stoppedRootMark(root, path.join(dir, 'missing'))).toBeNull();
  });

  it('returns null for a file containing only invalid lines', () => {
    fs.writeFileSync(file, '{bad json\nnull\n{"root": 42}\n');
    expect(stoppedRootMark(root, dir)).toBeNull();
  });

  it('does not resolve a root getter when marks are missing or invalid', () => {
    let calls = 0;
    const getRoot = () => {
      calls++;
      throw new Error('root should not be resolved');
    };

    expect(stoppedRootMark(getRoot, dir)).toBeNull();
    expect(calls).toBe(0);

    fs.writeFileSync(file, '{bad json\nnull\n{"root": 42}\n');
    expect(stoppedRootMark(getRoot, dir)).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns null for a throwing root getter and the mark for a matching getter', () => {
    new EndedJobsFile(file).append({ root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' });
    let calls = 0;
    expect(stoppedRootMark(() => {
      calls++;
      throw new Error('closed root');
    }, dir)).toBeNull();
    expect(calls).toBe(1);

    calls = 0;
    expect(stoppedRootMark(() => {
      calls++;
      return root;
    }, dir)).toEqual({ root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' });
    expect(calls).toBe(1);
  });

  it('sees an append and a subsequent clear on the next call', () => {
    const journal = new EndedJobsFile(file);
    const first = { root, kind: 'open', limit: 'time', at: '2026-11-17T10:00:00Z' } as const;
    const last = { root, kind: 'catch-up', limit: 'rss', at: '2026-11-17T11:00:00Z' } as const;
    journal.append(first);
    journal.append({ root: other, kind: 'sync', limit: 'time', at: '2026-11-17T10:30:00Z' });
    expect(stoppedRootMark(root, dir)).toEqual(first);
    journal.append(last);
    expect(stoppedRootMark(root, dir)).toEqual(last);
    journal.clearRoot(root);
    expect(stoppedRootMark(root, dir)).toBeNull();
  });
});
