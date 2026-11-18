/**
 * Whether this machine lets a test make a directory symlink, probed once on
 * import. Windows refuses one with EPERM without Developer Mode or admin
 * rights. A junction would get past that, but git lists a symlink as one entry
 * and the cases that use this test exactly that, so they skip instead. Any
 * other error is rethrown; the probe folder is always removed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const canLinkDirs = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-probe-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'link'), 'dir');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
