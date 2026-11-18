/** The builder.log line for a catch-up of `root` the WAL valve stopped: its message, the wait and the time (`at`) of the next attempt. */
export function valveStopLine(root: string, message: string, waitMs: number, at: Date): string {
  return `Catch-up of ${root} stopped by the WAL valve: ${message}; next attempt in ${waitMs / 1000} s, at ${at.toISOString()}`;
}
