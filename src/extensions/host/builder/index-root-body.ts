/**
 * The body of the CLI's `init` and `index` jobs (./cli-jobs.ts), run in the job's child process: get a writable
 * graph of the root (`init`: CodeGraph.init without indexing; `recreate`: CodeGraph.recreate, a new empty
 * database; `open`: the existing one), run `indexAll`, and close. Each progress of the engine is sent as a
 * payload as it came; with `verbose`, each console.log line of the engine is sent as `{log: line}`
 * (./capturing-log.ts), in order with the progress. The body takes no lock beyond the engine's own: a lease's
 * `writer.pid` is taken by the builder before the job runs.
 */
import CodeGraph from '../../../index';
import type { IndexResult } from '../../../extraction';
import { capturingLog } from './capturing-log';
import type { JobContext } from './job-context-type';
import { jsonValue } from './json-value';

const OPENS = {
  init: (root: string) => CodeGraph.init(root, { index: false }),
  recreate: (root: string) => CodeGraph.recreate(root),
  open: (root: string) => CodeGraph.open(root),
};

export async function indexRootBody(
  args: { root: string; open: 'init' | 'recreate' | 'open'; verbose: boolean },
  ctx: JobContext,
): Promise<IndexResult> {
  const cg = await OPENS[args.open](args.root);
  try {
    const index = (): Promise<IndexResult> => cg.indexAll({ onProgress: (progress) => ctx.progress(progress), verbose: args.verbose });
    return jsonValue(args.verbose ? await capturingLog((line) => ctx.progress({ log: line }), index) : await index());
  } finally {
    cg.close();
  }
}
