import { describe, expect, it } from 'vitest';
import { testFileReading } from '../../../src/extensions/queries/shared/testFileReading';

/** An in-memory reader over `files`, counting each read per path. */
function fakeReader(files: Record<string, string>): { read: (p: string) => string | undefined; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  return {
    read: (p) => {
      reads.set(p, (reads.get(p) ?? 0) + 1);
      return Object.hasOwn(files, p) ? files[p] : undefined;
    },
    reads,
  };
}

describe('testFileReading', () => {
  it('reads a Rust module file its parent declares under #[cfg(test)] as a test file', () => {
    const { read } = fakeReader({ 'src/store.rs': '#[cfg(test)]\nmod tests;\n' });
    expect(testFileReading(read)('src/store/tests.rs')).toBe(true);
  });

  it('does not read a module its parent declares plainly as a test file', () => {
    const { read } = fakeReader({ 'src/store.rs': 'mod tests;\n' });
    expect(testFileReading(read)('src/store/tests.rs')).toBe(false);
  });

  it('reads a path under a tests/ directory as a test file with nothing to read', () => {
    const { read } = fakeReader({});
    expect(testFileReading(read)('foo/tests/x.rs')).toBe(true);
  });

  it('does not read an ordinary TypeScript file as a test file', () => {
    const { read } = fakeReader({});
    expect(testFileReading(read)('src/store.ts')).toBe(false);
  });

  it('reads the parent once for two questions about the same path', () => {
    const { read, reads } = fakeReader({ 'src/store.rs': '#[cfg(test)]\nmod tests;\n' });
    const isTestFile = testFileReading(read);
    expect(isTestFile('src/store/tests.rs')).toBe(true);
    expect(isTestFile('src/store/tests.rs')).toBe(true);
    expect(reads.get('src/store.rs')).toBe(1);
  });
});
