/**
 * The spec of a job whose body is a module of this folder (./job-spec-type.ts). The module path has no
 * extension, so it resolves to the `.js` file in dist and to the `.ts` source under a test's require hook.
 * `writerPid` is this process's pid: the builder's.
 */
import * as path from 'path';
import type { JobSpec } from './job-spec-type';
import type { JobKind } from './queue';

/** The spec of a `kind` job of `root` that runs `exportName` of `./<moduleName>` with `args` (JSON). */
export function jobBodySpec(kind: JobKind, root: string, moduleName: string, exportName: string, args: unknown): JobSpec {
  return { kind, root, module: path.join(__dirname, moduleName), export: exportName, args, writerPid: process.pid };
}
