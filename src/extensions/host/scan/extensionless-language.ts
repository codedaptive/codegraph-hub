/**
 * The language of an extensionless file from its `#!` line (R-49(a)). A scan calls this for every path whose
 * last segment has no dot, so it costs one open and one read of at most 256 bytes, and it never throws:
 * any failure to read means "not a script CodeGraph parses".
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Language } from '../../../types';
import { shebangLanguage } from './shebang-language';

/** shebangLanguage looks at no more than this many characters. */
const HEAD_BYTES = 256;

/** Non-blocking, so an extensionless named pipe opens at once and the isFile check turns it away. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** The first HEAD_BYTES bytes of a regular file as UTF-8, or null when it is not one or cannot be read. */
function readHead(absolutePath: string): string | null {
  try {
    const fd = fs.openSync(absolutePath, OPEN_FLAGS);
    try {
      if (!fs.fstatSync(fd).isFile()) return null;
      const buffer = Buffer.alloc(HEAD_BYTES);
      return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, HEAD_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The language of `filePath` when its last segment has no dot and its `#!` line names an interpreter
 * CodeGraph parses. `source` is used instead of reading the file when given; a relative path is resolved
 * against `rootDir`, and with neither a root nor source it is not read and yields null.
 */
export function extensionlessLanguage(filePath: string, rootDir?: string, source?: string): Language | null {
  const lastSegment = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  if (lastSegment === '' || lastSegment.includes('.')) return null;
  if (source !== undefined) return shebangLanguage(source);
  let absolutePath = filePath;
  if (!path.isAbsolute(filePath)) {
    if (rootDir === undefined) return null;
    absolutePath = path.join(rootDir, filePath);
  }
  const head = readHead(absolutePath);
  return head === null ? null : shebangLanguage(head);
}
