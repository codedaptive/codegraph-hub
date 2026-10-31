/**
 * Test helper: the identity a server records in its lock for the state dir
 * `dir`, computed by the production rule (`getStateDirIdentity()`, which is
 * `dev:ino` off Windows and the lower-cased native realpath on it), so a fixture
 * that plants a lock record plants what a real server would, on every platform.
 * `dir` must exist. `CODEGRAPH_STATE_DIR` is pointed at it only for the call.
 */
import { getStateDirIdentity } from '../../../src/extensions/host/server/state-dir';

export function stateIdentityOf(dir: string): string {
  const saved = process.env.CODEGRAPH_STATE_DIR;
  process.env.CODEGRAPH_STATE_DIR = dir;
  try {
    const id = getStateDirIdentity();
    if (id === null) throw new Error(`state dir ${dir} does not exist; it has no identity`);
    return id;
  } finally {
    if (saved === undefined) delete process.env.CODEGRAPH_STATE_DIR;
    else process.env.CODEGRAPH_STATE_DIR = saved;
  }
}
