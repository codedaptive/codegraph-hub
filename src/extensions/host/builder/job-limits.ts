/**
 * The builder's per-job limits: a job that runs longer than `maxMs` of wall time, or whose process holds more
 * than `maxRssMb` resident, is ended and logged, and not retried (./job-limit-breach.ts decides, ./job-limit-line.ts
 * logs). The limits come from the builder's environment once, at start; a bad value falls back to the default
 * with a warning rather than stopping the builder, because a typo in a limit must not leave a machine with no
 * index builder at all.
 */

/** The two limits every builder job runs under. */
export interface JobLimits {
  maxMs: number;
  maxRssMb: number;
}

/** 60 minutes: well past the longest cold build of a large repository, short of a job left running all day. */
export const DEFAULT_JOB_MAX_MS = 3_600_000;

/** 8 GB: far above a healthy index run, low enough to end a runaway before it pushes the machine into swap. */
export const DEFAULT_JOB_MAX_RSS_MB = 8192;

/**
 * One variable's value: a positive whole number after trimming, else the default. Unset or blank is the
 * default with no warning; anything else that is not a positive whole number warns with the raw value. A number
 * too large to hold exactly (past Number.MAX_SAFE_INTEGER) is refused too: it would turn the limit off.
 */
function readLimit(env: NodeJS.ProcessEnv, name: string, fallback: number, warnings: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  if (value > 0 && Number.isSafeInteger(value)) return value;
  warnings.push(`${name}="${raw}" is not a positive whole number; using the default ${fallback}`);
  return fallback;
}

/** The builder's job limits from `env`, with one warning for each variable whose value was not usable. */
export function resolveJobLimits(env: NodeJS.ProcessEnv = process.env): { limits: JobLimits; warnings: string[] } {
  const warnings: string[] = [];
  const limits = {
    maxMs: readLimit(env, 'CODEGRAPH_BUILDER_JOB_MAX_MS', DEFAULT_JOB_MAX_MS, warnings),
    maxRssMb: readLimit(env, 'CODEGRAPH_BUILDER_JOB_MAX_RSS_MB', DEFAULT_JOB_MAX_RSS_MB, warnings),
  };
  return { limits, warnings };
}
