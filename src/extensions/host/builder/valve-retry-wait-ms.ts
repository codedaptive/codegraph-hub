/** First wait after a WAL valve stop: upstream #3354's timing (S-93), long enough for a pinned checkpoint to clear. */
const VALVE_RETRY_FIRST_MS = 5_000;
/** Longest wait between valve retries: upstream #3354's cap (S-93), so a root stuck behind the valve is still retried every few minutes. */
const VALVE_RETRY_MAX_MS = 300_000;

/** The wait before the next catch-up after `stops` WAL valve stops in a row (this one included, so >= 1): doubles per stop, capped. */
export function valveRetryWaitMs(stops: number): number {
  return Math.min(VALVE_RETRY_FIRST_MS * 2 ** (stops - 1), VALVE_RETRY_MAX_MS);
}
