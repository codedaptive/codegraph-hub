import type { StopOutcome } from '../../../mcp/server-control';

/**
 * What `stopServer` (src/mcp/server-control.ts) returns for the daemon proof's answer on the lock's socket
 * (probeServerProof), or null when the server proved itself and the stop goes on:
 *   - `no-answer` is `busy` and `mismatch` is `unverified`: nothing was proven about who listens, so no socket
 *     is named.
 *   - `unproven` is `unproven` and carries `socketPath`: something answered the hello as the server but did not
 *     prove it runs as this user, and the user is told to check who listens there.
 */
export function stopOutcomeOfProof(
  answer: 'proven' | 'unproven' | 'mismatch' | 'no-answer',
  info: { pid: number; version: string; socketPath: string },
): { outcome: StopOutcome; pid: number; version: string; socketPath?: string } | null {
  const { pid, version } = info;
  switch (answer) {
    case 'no-answer': return { outcome: 'busy', pid, version };
    case 'mismatch': return { outcome: 'unverified', pid, version };
    case 'unproven': return { outcome: 'unproven', pid, version, socketPath: info.socketPath };
    case 'proven': return null;
  }
}
