/**
 * The test ./clean-up-ended-job.ts applies before it removes an ended cold build's database: whether the file at
 * `dbFile` is the one the build created. `identityReported: false` says the job's child reported no database at
 * all (./is-created-database.ts), which keeps the dead child's `rebuild.pid` as well; absent, it counts as reported.
 */
export type BuildDatabaseTest = ((root: string, dbFile: string) => boolean) & { readonly identityReported?: boolean };
