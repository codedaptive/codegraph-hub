/**
 * What counts as a test file: blast splits test
 * dependents out of its modules with it, and orphans excludes symbols declared
 * in a test file with it.
 */

/** Test directories, `.test`/`.spec` JS/TS files, and Go/Python/Ruby `_test` files. */
export const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/i;
