/**
 * What counts as a test file, read from the path alone: blast splits test
 * dependents out of its modules with it, and orphans excludes symbols declared
 * in a test file with it. A Rust module file its parent declares under a test
 * `cfg` has no test path; `testFileReading` (`./testFileReading.ts`) adds that
 * reading for both.
 */

/** Test directories, `.test`/`.spec` JS/TS files, and Go/Python/Ruby `_test` files. */
export const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/i;
