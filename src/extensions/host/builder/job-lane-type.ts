/**
 * The builder queue's two lanes (./queue.ts): `cold` runs the whole-repository writes and VACUUMs one at a time, and `sync`
 * runs every other kind beside it (./job-lane.ts picks one for a job kind).
 */
export type JobLane = 'sync' | 'cold';
