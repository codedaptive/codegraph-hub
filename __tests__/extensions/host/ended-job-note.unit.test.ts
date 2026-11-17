import { describe, expect, it } from 'vitest';
import { endedJobNote } from '../../../src/extensions/host/builder/ended-job-note';

describe('endedJobNote', () => {
  it.each([
    ['time', 'time limit', 'CODEGRAPH_BUILDER_JOB_MAX_MS', 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB'],
    ['rss', 'memory limit', 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB', 'CODEGRAPH_BUILDER_JOB_MAX_MS'],
  ] as const)('explains a %s limit and explicit recovery', (limit, label, variable, otherVariable) => {
    const note = endedJobNote('/project/sub', { root: '/project', kind: 'cold-build', limit });
    expect(note).toContain('/project');
    expect(note).toContain('cold-build');
    expect(note).toContain('index builder');
    expect(note).toContain('stopped');
    expect(note).toContain(label);
    expect(note).toContain(variable);
    expect(note).not.toContain(otherVariable);
    expect(note).toContain('codegraph index');
    expect(note).toMatch(/not retried|not retry|won't retry|will not retry/i);
    expect(note).toContain('built-in tools');
    expect(note).toContain('Read');
    expect(note).toContain('Grep');
    expect(note).toContain('Glob');
  });
});
