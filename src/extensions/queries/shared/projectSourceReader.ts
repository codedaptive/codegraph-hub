/**
 * The project-file read the queries commands share: orphans reads every project file it needs through
 * it, and blast reads Rust parent modules through it to find out-of-line `#[cfg(test)]` modules.
 */
import * as fs from 'fs';
import type { SourceReader } from '../../../graph/test-code';
import { validatePathWithinRoot } from '../../../utils';

/**
 * A reader of project-relative paths under `absRoot`, as UTF-8 text. Only a file whose real location is
 * inside the project is read (the leak-safe policy of the content-serving reads, #527): an indexed
 * symlink leading outside, which the indexer follows (#935), is refused like a missing file. A refused
 * path or a failed read gives undefined. Each path is read once per reader, its answer (undefined
 * included) kept for the reader's life, so one run sees one text per file.
 */
export function projectSourceReader(absRoot: string): SourceReader {
  const cache = new Map<string, string | undefined>();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const text = read(absRoot, rel);
    cache.set(rel, text);
    return text;
  };
}

function read(absRoot: string, rel: string): string | undefined {
  const safe = validatePathWithinRoot(absRoot, rel);
  if (safe === null) return undefined;
  try {
    return fs.readFileSync(safe, 'utf8');
  } catch {
    return undefined;
  }
}
