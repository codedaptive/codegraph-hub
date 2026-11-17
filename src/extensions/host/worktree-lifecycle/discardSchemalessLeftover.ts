import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir, hasSchemalessDb } from '../../../directory';
import { isProcessAlive } from '../../../mcp/server-control';
import { readWriterLock } from '../../../mcp/writer-lock';

/**
 * Remove the database a killed cold build of `root` left without the schema,
 * so the build that follows can create it again (`CodeGraph.init` cannot run
 * its schema over a half-applied one). The caller holds `root`'s `rebuild.pid`;
 * `runColdBuild` (./cold-build.ts) calls this only after taking that lock over
 * from a dead holder (./isDeadHolderRecord.ts).
 *
 * Nothing is removed while `writer.pid` names a live process other than this
 * one, or when the database is absent, carries the schema, is not SQLite or
 * cannot be probed. Otherwise `codegraph.db` and its `-wal`, `-shm` and
 * `-journal` files are removed (best-effort, each on its own), one stderr line
 * says so, and the answer is true.
 *
 * A user's `codegraph init` takes no `rebuild.pid`, so one creating its
 * database while a dead holder's `rebuild.pid` is still in place looks the
 * same as the killed build's leftover and is not told apart.
 */
export function discardSchemalessLeftover(root: string): boolean {
  const writer = readWriterLock(root);
  if (writer && writer.pid !== process.pid && isProcessAlive(writer.pid)) return false;
  if (!hasSchemalessDb(root)) return false;
  const dbFile = path.join(getCodeGraphDir(root), 'codegraph.db');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
  process.stderr.write(`[CodeGraph] Discarded the schema-less database a killed cold build of ${root} left behind.\n`);
  return true;
}
