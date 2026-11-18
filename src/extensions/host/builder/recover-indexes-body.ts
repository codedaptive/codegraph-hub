/**
 * The body of a held root's `recover` job (./holder.ts), run in the job's child process: open the root's
 * database writable without rebuilding in line, rebuild off the thread the secondary indexes an interrupted
 * bulk load dropped (#1887), and close. The builder holds `writer.pid` for the hold; the body takes no lock.
 */
import CodeGraph from '../../../index';
import type { JobContext } from './job-context-type';

export async function recoverIndexesBody(args: { root: string }, _ctx: JobContext): Promise<null> {
  const cg = CodeGraph.openSync(args.root, { deferIndexRecovery: true });
  try {
    await cg.recoverIndexes();
    return null;
  } finally {
    cg.close();
  }
}
