import type { JobSpec } from '../../../../src/extensions/host/builder/job-spec-type';
import type { JobRunner } from '../../../../src/extensions/host/builder/job-runner-type';

require('./ts-require-hook.cjs');

function jsonRoundTrip(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new TypeError('job value is not JSON');
    if (seen.has(item)) throw new TypeError('job value is not JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError('job value is not JSON');
    seen.add(item);
    for (const value of Object.values(item)) validate(value);
    seen.delete(item);
  };
  validate(value);
  return JSON.parse(JSON.stringify(value));
}

export function inProcessJobRunner(): {
  runJob: JobRunner;
  specs: JobSpec[];
  databases: Array<{ root: string; identity: string | null }>;
} {
  const specs: JobSpec[] = [];
  const databases: Array<{ root: string; identity: string | null }> = [];
  const runJob: JobRunner = async (_id, spec, onProgress) => {
    specs.push(spec);
    const body = require(spec.module)[spec.export];
    if (typeof body !== 'function') throw new Error(`job module ${spec.module} has no function export ${spec.export}`);
    const args = jsonRoundTrip(spec.args);
    const result: unknown = await body(args, {
      progress: (payload: unknown) => onProgress?.(payload),
      reportDatabase: (root: string, identity: string | null) => databases.push({ root, identity }),
      writerPid: process.pid,
    });
    return jsonRoundTrip(result);
  };
  return { runJob, specs, databases };
}
