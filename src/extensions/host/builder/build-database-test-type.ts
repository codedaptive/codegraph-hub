/**
 * The test ./clean-up-ended-job.ts applies before it removes an ended cold build's database: whether the file at
 * `dbFile` is the one the build created. `identityReported: false` says the job's child reported no database at
 * all (./is-created-database.ts), so the clean-up applies the killed cold build's leftover rule instead of this
 * test; absent, it counts as reported.
 */
export type BuildDatabaseTest = ((root: string, dbFile: string) => boolean) & { readonly identityReported?: boolean };
