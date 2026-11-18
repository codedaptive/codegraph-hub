/**
 * The body of a held root's `open` job (./holder.ts), run in the job's child process: open the root's database
 * writable, so the migrations run and an interrupted bulk load's state is healed, say whether the secondary
 * indexes that load dropped still need rebuilding (the `recover` job's work, ./recover-indexes-body.ts), and
 * close. The builder took `writer.pid` for the hold before this runs; the body takes no lock.
 *
 * The open also starts CodeGraph's oversized-WAL heal without awaiting it (db/index.ts `open`: an off-thread
 * PASSIVE then TRUNCATE checkpoint), and the close and the child's exit right after the result can cut that
 * checkpoint off. That is safe: an interrupted checkpoint leaves the database and its WAL consistent, and the
 * next writable open of the root starts the heal again.
 */
import CodeGraph from '../../../index';
import type { JobContext } from './job-context-type';

export async function openHeldRootBody(args: { root: string }, _ctx: JobContext): Promise<{ recoveryPending: boolean }> {
  const cg = CodeGraph.openSync(args.root, { deferIndexRecovery: true });
  try {
    return { recoveryPending: cg.hasPendingIndexRecovery() };
  } finally {
    cg.close();
  }
}
