/**
 * Victim process for the dead-lock-reclaim tests (unit U3 of
 * worktree-lifecycle).
 *
 * Takes project locks through the real code from src, so each record on disk
 * is in exactly the format the code writes (whatever start-time field the
 * code records included), prints one JSON line `{"pid": <its pid>, "taken":
 * [...]}`, and then stays alive without releasing anything until the test
 * kills it. A SIGKILL'd victim leaves its records behind, as a server killed
 * mid-write does.
 *
 * Usage: node run-ts.cjs dead-lock-victim.ts -- <projectRoot> <lock>[,<lock>...]
 *   lock = writer    tryAcquireWriterLock(root, 'direct')                  -> .codegraph/writer.pid
 *   lock = rebuild   tryAcquireWriterLock(root, 'rebuild', 'rebuild.pid')  -> .codegraph/rebuild.pid
 *   lock = filelock  FileLock on .codegraph/codegraph.lock with the lockStamp owner CodeGraph passes
 * A lock it fails to take is an error (exit 2), never a quiet partial result.
 */
import * as path from 'path';
import { tryAcquireWriterLock, lockStamp, isForeignLockRecord } from '../../../../src/mcp/writer-lock';
import { FileLock } from '../../../../src/utils';
import { getCodeGraphDir } from '../../../../src/directory';

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [root, lockList] = args;
  if (!root || !lockList) throw new Error('usage: dead-lock-victim.ts -- <projectRoot> <lock>[,<lock>...]');
  const taken: string[] = [];
  for (const lock of lockList.split(',')) {
    switch (lock) {
      case 'writer':
      case 'rebuild': {
        const r = lock === 'writer'
          ? tryAcquireWriterLock(root, 'direct')
          : tryAcquireWriterLock(root, 'rebuild', 'rebuild.pid');
        if (r.kind !== 'acquired') throw new Error(`${lock}: taken by ${JSON.stringify(r.existing)}`);
        break;
      }
      case 'filelock': {
        // The owner CodeGraph's constructor passes (src/index.ts).
        new FileLock(path.join(getCodeGraphDir(root), 'codegraph.lock'), {
          stamp: () => lockStamp(root),
          isForeign: (rec: unknown) => isForeignLockRecord(rec, root),
        }).acquire();
        break;
      }
      default:
        throw new Error(`unknown lock ${lock}`);
    }
    taken.push(lock);
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, taken })}\n`);
  // Hold everything until killed.
  setInterval(() => {}, 1000);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
}
