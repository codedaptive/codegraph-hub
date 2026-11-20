import type { StopOutcome } from '../../../mcp/server-control';

/**
 * What `codegraph daemon --stop` tells the user about a {@link StopOutcome}, and its exit code:
 *   - `not-running`: there was no server to stop; exit 0.
 *   - `stopped`: SIGTERM was attempted and the pid is no longer alive; exit 0.
 *   - `busy`: the server accepted the connection but said nothing in time; retry later.
 *   - `unverified`: the lock's process did not answer as the server; the stale lock may be deleted.
 *   - `unproven`: something answered as the server but did not prove it runs as this user, so nothing was
 *     signalled and no kill command is offered; the user checks who listens on the socket.
 *   - `kept`: the server was left running. Only the launcher's `onlyIfOlderThan` path of stopServer returns it,
 *     and `daemon --stop` never passes that option; the case is here so the switch stays exhaustive.
 *   - `still-running`: the proven server did not exit after SIGTERM; the forced kill for `platform` is named.
 */
export function describeStopOutcome(
  result: { outcome: StopOutcome; pid?: number; version?: string; socketPath?: string },
  platform: NodeJS.Platform = process.platform,
): { level: 'success' | 'info' | 'error'; text: string; exitCode: 0 | 1 } {
  const { pid, version, socketPath } = result;
  const server = `the CodeGraph server (pid ${pid}, v${version})`;
  switch (result.outcome) {
    case 'not-running':
      return { level: 'info', exitCode: 0, text: 'No CodeGraph server running.' };
    case 'stopped':
      return { level: 'success', exitCode: 0, text: `Stopped ${server}.` };
    case 'busy':
      return fail(
        `The CodeGraph server is running but busy (pid ${pid}, v${version}): ` +
        'it accepted the connection and sent no hello within 1 s, so it was left running. ' +
        'Retry `codegraph daemon --stop` in a moment, or wait for it to finish.',
      );
    case 'unverified':
      return fail(
        `Process ${pid} holds the server lock but did not answer as the CodeGraph server, so it was left running. ` +
        'If it is not a CodeGraph server, delete the stale server.pid in the state dir. ' +
        'That does not stop a process listening on the server socket; ' +
        'if `codegraph index`, `uninit` or `init` still refuses, it names that socket.',
      );
    case 'unproven':
      return fail(
        `The process on ${socketPath} answered as ${server} ` +
        'but did not prove it runs as this user, so nothing was signalled. ' +
        `Check whether pid ${pid} is the process listening on ${socketPath}; ` +
        'if it is, and it is a CodeGraph server you started, stop it by hand.',
      );
    case 'kept':
      return fail(`Left ${server} running.`);
    case 'still-running': {
      const kill = platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
      return fail(
        `The CodeGraph server (pid ${pid}, v${version}) proved itself on its socket but did not exit after SIGTERM. ` +
        `Stop it with \`${kill}\`; that skips its graceful shutdown.`,
      );
    }
  }
}

function fail(text: string): { level: 'error'; text: string; exitCode: 1 } {
  return { level: 'error', exitCode: 1, text };
}
