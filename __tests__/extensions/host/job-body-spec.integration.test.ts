/**
 * jobBodySpec (src/extensions/host/builder/job-body-spec.ts): the module is the extensionless absolute path of a
 * file in the builder folder, and the writer pid is this process's.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { jobBodySpec } from '../../../src/extensions/host/builder/job-body-spec';

describe('jobBodySpec', () => {
  it('names the body module in the builder folder without an extension, with the args and this pid', () => {
    const spec = jobBodySpec('open', '/repo', 'open-held-root-body', 'openHeldRootBody', { root: '/repo' });
    expect(spec).toEqual({
      kind: 'open',
      root: '/repo',
      module: path.resolve(__dirname, '../../../src/extensions/host/builder/open-held-root-body'),
      export: 'openHeldRootBody',
      args: { root: '/repo' },
      writerPid: process.pid,
    });
  });
});
