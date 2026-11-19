import * as fs from 'fs';
import * as path from 'path';

/** `p` resolved and with every symlink followed. */
export function real(p: string): string {
  return fs.realpathSync(path.resolve(p));
}
