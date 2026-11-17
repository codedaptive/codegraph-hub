/** A seeder's staging copy: `codegraph.db.seed-<pid>-<hex>.tmp` and SQLite's side files for it. */
const SEED_STAGING_NAME = /^codegraph\.db\.seed-(\d+)-[0-9a-f]+\.tmp(?:-journal|-wal|-shm)?$/;

/** The pid of the seeder that wrote the staging file `name`, or null when `name` is not one. */
export function seedStagingPid(name: string): number | null {
  const m = SEED_STAGING_NAME.exec(name);
  return m ? Number(m[1]) : null;
}
