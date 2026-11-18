/**
 * A message from a job's child process to the builder (./job-child-main.ts to ./job-supervisor.ts), in the order
 * the body made them: its progress, the identity (`dev:ino`, or null where the platform has none) of a database
 * it created at `root`, and last its result or its error.
 */
export type JobChildMessage =
  | { type: 'progress'; payload: unknown }
  | { type: 'database-created'; root: string; identity: string | null }
  | { type: 'result'; value: unknown }
  | { type: 'error'; message: string };
