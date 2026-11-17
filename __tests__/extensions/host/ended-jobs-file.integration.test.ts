import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';

const first = { root: '/a', kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' } as const;
const second = { root: '/b', kind: 'sync', limit: 'rss', at: '2026-11-16T10:01:00.000Z' } as const;

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codegraph-ended-jobs-'));
  file = join(dir, 'ended.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('EndedJobsFile', () => {
  it('creates a file and appends one JSON line per job', () => {
    const journal = new EndedJobsFile(file);
    journal.append(first);
    journal.append(second);
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toEqual({ root: '/a', kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00.000Z' });
    expect(JSON.parse(lines[1])).toEqual({ root: '/b', kind: 'sync', limit: 'rss', at: '2026-11-16T10:01:00.000Z' });
  });

  it('loads valid jobs repeatedly without deleting the file, skipping bad lines', () => {
    writeFileSync(file, [
      JSON.stringify(first),
      '{not json',
      'null',
      JSON.stringify({ root: '/bad', kind: 'sync', limit: 'rss' }),
      JSON.stringify({ root: 5, kind: 'sync', limit: 'rss', at: '2026-11-16T10:00:00.000Z' }),
      JSON.stringify({ root: '/bad', kind: 'not-a-kind', limit: 'rss', at: '2026-11-16T10:00:00.000Z' }),
      JSON.stringify({ root: '/bad', kind: 'sync', limit: 'memory', at: '2026-11-16T10:00:00.000Z' }),
      JSON.stringify({ root: '/bad', kind: 'sync', limit: 'rss', at: 5 }),
      JSON.stringify(second),
      '',
    ].join('\n'));
    const journal = new EndedJobsFile(file);
    expect(journal.load()).toEqual([first, second]);
    expect(existsSync(file)).toBe(true);
    expect(journal.load()).toEqual([first, second]);
  });

  it('returns an empty list for a missing file', () => {
    expect(new EndedJobsFile(file).load()).toEqual([]);
  });

  it('clearRoot matches canonical paths, preserves other lines in order, and deletes the empty file', () => {
    const journal = new EndedJobsFile(file);
    journal.append(first);
    journal.append(second);
    journal.append({ ...first, kind: 'sync' });
    journal.clearRoot('/a/');
    expect(journal.load()).toEqual([second]);
    journal.clearRoot('/b');
    expect(existsSync(file)).toBe(false);
  });

  it('clearRoot ignores missing files and filesystem errors', () => {
    expect(() => new EndedJobsFile(file).clearRoot('/a')).not.toThrow();
    expect(existsSync(file)).toBe(false);
    expect(() => new EndedJobsFile(dir).clearRoot('/a')).not.toThrow();
  });

  it('never throws on filesystem errors during append or load', () => {
    const unwritable = new EndedJobsFile(join(dir, 'missing-parent', 'jobs'));
    expect(() => unwritable.append(first)).not.toThrow();
    const directory = new EndedJobsFile(dir);
    expect(() => directory.append(first)).not.toThrow();
    expect(directory.load()).toEqual([]);
  });
});
