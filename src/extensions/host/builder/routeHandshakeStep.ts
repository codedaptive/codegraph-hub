/**
 * One step of the CLI route's handshake with the machine server (./cli-route.ts RouteConnection). Pure apart
 * from reading this user's daemon key for the proof check (src/mcp/daemonAnswerProves.ts).
 */
import type { ServerLockInfo } from '../../../mcp/daemon-paths';
import { controlClientHelloLine, isServerHello } from '../../../mcp/server-control';
import { daemonAnswerProves } from '../../../mcp/daemonAnswerProves';
import { daemonChallengeLine } from '../../../mcp/daemonChallengeLine';
import { isJsonObject } from '../server/isJsonObject';

/**
 * The first line is the hello of the server `lock` names (its pid and version), else this is not that server;
 * the challenge line goes only to that server. The next line must be its proof: only then does the control
 * client hello go, and with it any request. Answers the phase that follows and the line to write, or null
 * when the handshake failed, including for any message that is not a non-null, non-array object.
 */
export function routeHandshakeStep(
  phase: 'hello' | 'proof',
  message: unknown,
  lock: ServerLockInfo,
  challenge: string,
): { next: 'proof' | 'open'; write: string } | null {
  if (!isJsonObject(message)) return null;
  if (phase === 'hello') {
    const ok = isServerHello(message) && message.pid === lock.pid && message.codegraph === lock.version;
    return ok ? { next: 'proof', write: daemonChallengeLine(challenge) } : null;
  }
  return daemonAnswerProves(challenge, lock.socketPath, message.codegraph_proof)
    ? { next: 'open', write: controlClientHelloLine() }
    : null;
}
