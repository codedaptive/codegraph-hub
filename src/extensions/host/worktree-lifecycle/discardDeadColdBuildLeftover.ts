import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../../../directory';
import { isProcessAlive } from '../../../mcp/server-control';
import { readWriterLock } from '../../../mcp/writer-lock';

/**
 * Remove the database a killed cold build of `root` left, whatever it holds: none, part or all of the schema,
 * and part of an index. Two callers hold the right to it through `rebuild.pid`: the next cold build, which took
 * the lock over from a dead cold build's record (./deadColdBuildHolder.ts, ./cold-build.ts), and the index
 * builder ending a cold build's child that reported no database, while that lock still names the child
 * (../builder/clean-up-ended-job.ts). The file is that build's unfinished work; the next cold build creates it
 * again (`CodeGraph.init` fails on a half-applied schema, and a schema'd one would pass for a built index).
 *
 * Nothing is removed while `writer.pid` names a live process other than `buildPid` (the process doing the cold
 * build: by default this one; the builder passes its killed child's), or when there is no database. Otherwise
 * `codegraph.db` and its `-wal`, `-shm` and `-journal` files are removed (best-effort, each on its own) and one
 * stderr line says so.
 *
 * A user's `codegraph init` takes no `rebuild.pid`, so one creating its database while the dead build's
 * `rebuild.pid` is still in place looks the same as the leftover and is not told apart.
 */
export function discardDeadColdBuildLeftover(root: string, buildPid: number = process.pid): void {
  const writer = readWriterLock(root);
  if (writer && writer.pid !== buildPid && isProcessAlive(writer.pid)) return;
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!fs.existsSync(dbFile)) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
  process.stderr.write(`[CodeGraph] Discarded the database a killed cold build of ${root} left behind.\n`);
}
