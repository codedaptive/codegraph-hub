/**
 * The refusal `codegraph index`, `codegraph uninit` and the `codegraph init` of a root the builder stopped at a limit
 * give when something answered on a server socket but did not confirm it released the root (`requestProjectRelease` answered 'failed'), so the database may still be open.
 *
 * The advice follows what `codegraph daemon --stop` does (stopServer, src/mcp/server-control.ts): it acts only on the
 * server its lock (server.pid) names, once that server answers as it, and sweeps the socket files only after stopping
 * it. Each stop outcome gets its own advice. 'busy' is the lock's own server, up but silent: retry the stop.
 * 'still-running' is the lock's server that did not exit: stop that pid as the stop says. Only 'no server running'
 * and 'unverified' (a lock holder that did not answer as the server) mean whatever answers on the socket is not this
 * state dir's server; it is never signalled and its socket stays, so the text names the socket and says to find and
 * stop whatever listens there.
 */

/** The refusal for `realRoot`, whose release over `socketPath` was not confirmed; `retry` is the backticked command. */
export function unprovenReleaseRefusal(realRoot: string, socketPath: string, retry: string): string {
  return `The CodeGraph server on ${socketPath} did not confirm that it released ${realRoot}, ` +
    'so it may still hold the database open. ' +
    `Stop it with \`codegraph daemon --stop\` (clients reconnect and start a fresh one), then retry ${retry}. ` +
    '`codegraph daemon --stop` acts only on the server its lock (server.pid) names, once that server answers as it. ' +
    'If the stop reports the server busy, retry the stop in a moment; ' +
    'if it reports the server did not exit, stop that pid as it says. ' +
    'If it reports no server running, or a process that holds the server lock but did not answer as the server ' +
    `(deleting that stale server.pid does not free the socket), whatever answers on ${socketPath} is not this state dir's server: ` +
    `find the process listening on ${socketPath} and stop it, then retry ${retry}.`;
}
