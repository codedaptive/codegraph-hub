/**
 * Which slot of the builder queue (./queue.ts) a running job holds: `repo` is its repository's own slot (one job
 * per repository at a time), `bypass` one of the shared slots a repository's next job may take while its own is
 * busy and the machine's load is below the limit (./next-start.ts; R-53).
 */
export type JobLane = 'repo' | 'bypass';
