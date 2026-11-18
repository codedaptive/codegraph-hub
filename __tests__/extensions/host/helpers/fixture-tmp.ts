import * as os from 'os';

// The harness's POSIX TMPDIR can have an indexed ancestor, changing pin targets and adding nested-repo git probes.
export const FIXTURE_TMP = process.platform === 'win32' ? os.tmpdir() : '/tmp';
