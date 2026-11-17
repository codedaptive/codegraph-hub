import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearEndedRoot } from '../../../src/extensions/host/builder/clear-ended-root';
import { EndedJobsFile } from '../../../src/extensions/host/builder/ended-jobs-file';
import { endedJobs } from '../../../src/extensions/host/builder/ended-jobs';

const first = { root: '/first', kind: 'cold-build', limit: 'time', at: '2026-11-16T10:00:00Z' } as const;
const second = { root: '/second', kind: 'sync', limit: 'rss', at: '2026-11-16T10:00:00Z' } as const;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cg-clear-ended-')); endedJobs.replaceAll([]); });
afterEach(() => { endedJobs.replaceAll([]); rmSync(dir, { recursive: true, force: true }); });

describe('clearEndedRoot', () => {
  it('removes only the selected root from disk and memory', () => {
    const file = join(dir, 'builder-ended-jobs.jsonl');
    const journal = new EndedJobsFile(file);
    journal.append(first);
    journal.append(second);
    endedJobs.replaceAll([first, second]);
    clearEndedRoot('/first/', dir);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(second)}\n`);
    expect(endedJobs.has('/first', 'cold-build')).toBe(false);
    expect(endedJobs.find('/second', 'sync')).toEqual(second);
  });

  it('does not create a missing state directory or throw', () => {
    const missing = join(dir, 'missing');
    endedJobs.add(first);
    expect(() => clearEndedRoot('/first', missing)).not.toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(endedJobs.has('/first', 'cold-build')).toBe(false);
  });
});
