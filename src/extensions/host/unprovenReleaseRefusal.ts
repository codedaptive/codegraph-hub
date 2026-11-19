/**
 * The refusal `codegraph index`, `codegraph uninit` and the `codegraph init` of a root the builder stopped at a limit
 * give when something answered on a server socket but did not confirm it released the root (`requestProjectRelease` answered 'failed'), so the database may still be open.
 *
 * `codegraph daemon --stop` (stopServer, src/mcp/server-control.ts) acts only on the pid its lock (server.pid) names,
 * after the hello on the lock's socket names that pid. 'busy', 'not-running' and 'unverified' leave the holder of
 * that socket unknown ('busy' is inconclusive, server-control.ts:134-136), and the socket that failed may not be the
 * lock's, so every outcome but a stop that clears the refusal gets the same next step: find and stop whatever listens
 * on the named socket.
 */

/** The refusal for `realRoot`, whose release over `socketPath` was not confirmed; `retry` is the backticked command. */
export function unprovenReleaseRefusal(realRoot: string, socketPath: string, retry: string): string {
  return `The process on ${socketPath} did not confirm that it released ${realRoot}, ` +
    'so it may still hold the database open. ' +
    `Run \`codegraph daemon --stop\`, then retry ${retry}. ` +
    'The stop acts only on the process the server lock (server.pid) names, ' +
    "and only when the hello on the lock's socket names that process. " +
    `If the stop does not report that it stopped the server, or ${retry} refuses again, ` +
    `find the process listening on ${socketPath}, check it is nothing you need, stop it, then retry ${retry}.`;
}
