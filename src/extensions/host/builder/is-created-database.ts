/**
 * The test ./clean-up-ended-job.ts applies before it removes an ended cold build's database: whether the file at
 * `dbFile` is the one the job's child reported creating, by its identity (`dev:ino`). No identity (null) means the
 * child was killed before CodeGraph.init returned, or runs where the platform gives none (win32: statInode is null),
 * and proves nothing, so the test answers false and says so (`identityReported: false`): the clean-up then
 * discards the file by the killed cold build's leftover rule.
 */
import { statInode } from '../../../directory';
import type { BuildDatabaseTest } from './build-database-test-type';

export function isCreatedDatabase(createdDatabase: string | null): BuildDatabaseTest {
  return Object.assign(
    (_root: string, dbFile: string) => createdDatabase !== null && statInode(dbFile) === createdDatabase,
    { identityReported: createdDatabase !== null },
  );
}
