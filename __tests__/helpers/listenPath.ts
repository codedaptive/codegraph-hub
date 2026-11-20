import * as path from 'path';

/**
 * The path a test server listens on: a named pipe on Windows, which cannot bind a filesystem socket path,
 * and a socket file in `dir` elsewhere.
 */
export function listenPath(dir: string, name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(dir)}-${name}`
    : path.join(dir, `${name}.sock`);
}
