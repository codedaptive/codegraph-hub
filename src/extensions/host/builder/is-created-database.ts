/**
 * The test ./clean-up-ended-job.ts applies before it removes an ended cold build's database: whether the file at
 * `dbFile` is the one the job's child reported creating, by its identity (`dev:ino`). A child that reported none
 * (null) proves nothing, so its database is kept.
 */
import { statInode } from '../../../directory';

export function isCreatedDatabase(createdDatabase: string | null): (root: string, dbFile: string) => boolean {
  return (_root, dbFile) => createdDatabase !== null && statInode(dbFile) === createdDatabase;
}
