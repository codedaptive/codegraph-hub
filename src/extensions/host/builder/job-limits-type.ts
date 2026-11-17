/** The two limits every builder job runs under, read from the environment by ./job-limits.ts. */
export interface JobLimits {
  maxMs: number;
  maxRssMb: number;
}
