/**
 * Which project files are test files, as blast and orphans read them: the path (`TEST_PATH`), and, for
 * a Rust module file, its parent's declaration under a test `cfg` (`inCfgTestFile`).
 */
import { inCfgTestFile, type SourceReader } from '../../../graph/test-code';
import { TEST_PATH } from './test-path';

/**
 * A predicate on project-relative paths: true when `TEST_PATH` matches, or the path is a Rust module
 * file its parent declares under a test `cfg` (`src/store/tests.rs` behind `#[cfg(test)] mod tests;`),
 * read through `readSource`. Each path's answer is kept for the life of the returned function, since
 * one run asks about the same file many times and each Rust answer reads parent files.
 */
export function testFileReading(readSource: SourceReader): (path: string) => boolean {
  const answers = new Map<string, boolean>();
  return (path) => {
    const known = answers.get(path);
    if (known !== undefined) return known;
    const answer = TEST_PATH.test(path) || inCfgTestFile(path, readSource);
    answers.set(path, answer);
    return answer;
  };
}
