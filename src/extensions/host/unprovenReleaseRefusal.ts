/**
 * The refusal `codegraph index` and `codegraph uninit` give when something answered on a server socket but did not
 * confirm it released the root (`requestProjectRelease` answered 'failed'), so the database may still be open.
 *
 * The advice follows what `codegraph daemon --stop` does (stopServer, src/mcp/server-control.ts): it acts only on the
 * server its lock (server.pid) names and proves, and sweeps the socket files only after stopping that server. A
 * process on the socket that is not the lock's server is never signalled and its socket stays, so the text names
 * the socket and says to find and stop whatever listens there.
 */

/** The refusal for `realRoot`, whose release over `socketPath` was not confirmed; `retry` is the backticked command. */
export function unprovenReleaseRefusal(realRoot: string, socketPath: string, retry: string): string {
  return `The CodeGraph server on ${socketPath} did not confirm that it released ${realRoot}, ` +
    'so it may still hold the database open. ' +
    `Stop it with \`codegraph daemon --stop\` (clients reconnect and start a fresh one), then retry ${retry}. ` +
    '`codegraph daemon --stop` stops only the server its lock (server.pid) names and proves. ' +
    'If it reports the server busy, retry the stop in a moment. ' +
    'If it reports no server running, or a process that holds the server lock but did not answer as the server ' +
    `(deleting that stale server.pid does not free the socket), or this refusal comes back, whatever answers on ${socketPath} is not that server: ` +
    `find the process listening on ${socketPath} and stop it, then retry ${retry}.`;
}
