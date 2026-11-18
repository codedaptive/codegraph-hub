/**
 * The test ./clean-up-ended-job.ts applies before it removes an ended cold build's database: whether the file at
 * `dbFile` is the one the job's child reported creating, by its identity (`dev:ino`). A child that reported none
 * (null) proves nothing, so its database is kept, and the test says so (`identityReported: false`).
 */
import { statInode } from '../../../directory';
import type { BuildDatabaseTest } from './build-database-test-type';

export function isCreatedDatabase(createdDatabase: string | null): BuildDatabaseTest {
  return Object.assign(
    (_root: string, dbFile: string) => createdDatabase !== null && statInode(dbFile) === createdDatabase,
    { identityReported: createdDatabase !== null },
  );
}
