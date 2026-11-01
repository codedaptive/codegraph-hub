/**
 * Competitor A for lock-takeover-race.gate.test.ts.
 *
 * Run as a separate process (launched as `node run-ts.cjs` by the gate's
 * competitorLaunch) from inside taker B's
 * `fs.unlinkSync(lockPath)`, before B's unlink proceeds. It loads the real
 * lock code from src and performs the same stale-lock takeover B is in the
 * middle of, then prints one JSON line: `{"acquired": boolean}` (plus the
 * server record it wrote, for the daemon case).
 *
 * `acquired: false` means only that the lock code reported the lock held: a
 * `taken` result, or FileLock's "locked by another process" error. Any other
 * error (a crash, a broken import, an unexpected throw) is never folded into
 * "did not acquire": it exits non-zero with the stack on stderr, so the gate's
 * execFileSync throws and its `hook.error === null` assertion fails instead
 * of passing vacuously on one acquisition. FileLock's held message is printed
 * as `held`; the output never has an `error` field, and the gate rejects any
 * line that does, or whose `acquired` is not a boolean.
 *
 * Usage: node run-ts.cjs lock-takeover-competitor.ts -- <kind> <arg> <deadPid>
 *   kind = writer        arg = projectRoot   (tryAcquireWriterLock)
 *   kind = filelock      arg = lockPath      (new FileLock(lockPath).acquire())
 *   kind = filelock-owner arg = projectRoot  (FileLock on .codegraph/codegraph.lock with a lockStamp owner)
 *   kind = daemon        arg = stateDir      (clearStaleDaemonLock, then tryAcquireDaemonLock)
 *     CODEGRAPH_STATE_DIR must name that same isolated state dir.
 */
import * as path from 'path';
import { tryAcquireWriterLock, lockStamp, isForeignLockRecord } from '../../../../src/mcp/writer-lock';
import { FileLock } from '../../../../src/utils';
import { getCodeGraphDir } from '../../../../src/directory';
import { getServerPidPath } from '../../../../src/mcp/daemon-paths';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [kind, arg, deadPidText] = args;
  const deadPid = Number(deadPidText);
  let out: Record<string, unknown>;

  switch (kind) {
    case 'writer': {
      // A throw from the lock code propagates to main's handler (exit 2).
      const r = tryAcquireWriterLock(arg!, 'fallback');
      out = { acquired: r.kind === 'acquired' };
      break;
    }
    case 'filelock':
    case 'filelock-owner': {
      const lockPath = kind === 'filelock' ? arg! : path.join(getCodeGraphDir(arg!), 'codegraph.lock');
      const owner = kind === 'filelock'
        ? undefined
        : { stamp: () => lockStamp(arg!), isForeign: (rec: unknown) => isForeignLockRecord(rec, arg!) };
      try {
        new FileLock(lockPath, owner).acquire();
        out = { acquired: true };
      } catch (err) {
        // Only FileLock's own "held" error counts as a loss; anything else
        // propagates to main's handler (exit 2).
        const message = err instanceof Error ? err.message : '';
        if (!message.includes('locked by another process')) throw err;
        out = { acquired: false, held: message };
      }
      break;
    }
    case 'daemon': {
      // daemon.ts pulls in the MCP engine; load it only for this case.
      const daemon = await import('../../../../src/mcp/daemon');
      if (!arg || !path.isAbsolute(arg) || process.env.CODEGRAPH_STATE_DIR !== arg) {
        throw new Error('daemon competitor requires the isolated CODEGRAPH_STATE_DIR passed by the gate');
      }
      const pidPath = getServerPidPath();
      // A throw from either call propagates to main's handler (exit 2).
      const cleared = daemon.clearStaleDaemonLock(pidPath, deadPid);
      const r = daemon.tryAcquireDaemonLock();
      out = { acquired: r.kind === 'acquired', cleared, record: r.kind === 'acquired' ? r.info : null };
      break;
    }
    default:
      throw new Error(`unknown kind ${kind}`);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(2);
  },
);
