/** Which limit a builder job went over, with the limit and what was measured, for the log line and the error. */
export type LimitBreach =
  | { limit: 'time'; maxMs: number; measuredMs: number }
  | { limit: 'rss'; maxRssMb: number; measuredRssMb: number };
