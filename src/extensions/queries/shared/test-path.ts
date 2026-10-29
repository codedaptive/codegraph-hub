/**
 * What counts as a test file, for every query in the zone: blast splits test
 * dependents out of its modules with it, and orphans excludes symbols declared
 * in a test file with it.
 */

/** graft 0.16's test-path pattern, verbatim: test directories, `.test`/`.spec` JS/TS files, Go/Python/Ruby `_test` files. */
export const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$/i;
