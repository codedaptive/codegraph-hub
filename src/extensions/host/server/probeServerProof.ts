import * as net from 'net';
import type { ServerLockInfo } from '../../../mcp/daemon-paths';
import { newDaemonChallenge } from '../../../mcp/daemon-proof';
import { daemonAnswerProves } from '../../../mcp/daemonAnswerProves';
import { daemonChallengeLine } from '../../../mcp/daemonChallengeLine';
import { isJsonObject } from './isJsonObject';

type ProofAnswer = 'proven' | 'unproven' | 'mismatch' | 'no-answer';

/** Bound on buffered bytes, the same as the hello probe's (src/mcp/daemon-paths.ts probeServerHello). */
const MAX_BUFFERED_BYTES = 4096;

/**
 * Whether the process on the lock's socket is this user's CodeGraph server, before anything signals it.
 * The hello alone names a pid and version anyone can copy; the proof answers a fresh challenge with the
 * owner-only key (src/mcp/daemon-proof.ts), so only a server of this user can give it.
 *
 *   - `mismatch`: an invalid lock, a socket that fails or closes before the hello, or a first line that is not
 *     a hello naming protocol 1, the lock's pid and its version (the check of probeServerHello).
 *   - `no-answer`: connected, and no byte arrived within `timeoutMs`; inconclusive.
 *   - `unproven`: the hello matched, and the next line was not this user's proof for this socket path, the
 *     socket failed or closed first, or nothing came within a fresh `timeoutMs`.
 *   - `proven`: the hello matched and the server proved itself.
 *
 * Nothing is written before the hello, and after it only the challenge line, never a client hello.
 */
export function probeServerProof(info: ServerLockInfo, timeoutMs = 1_000): Promise<ProofAnswer> {
  if (
    !Number.isInteger(info.pid) || info.pid <= 0 ||
    typeof info.socketPath !== 'string' || info.socketPath.length === 0
  ) {
    return Promise.resolve('mismatch');
  }
  return new Promise<ProofAnswer>((resolve) => {
    const challenge = newDaemonChallenge();
    let phase: 'hello' | 'proof' = 'hello';
    let buffer = Buffer.alloc(0);
    let received = 0;
    let connected = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.createConnection(info.socketPath);
    const finish = (answer: ProofAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    // A failure before the hello says it is not the server; after a matching hello, that it did not prove itself.
    const failed = () => finish(phase === 'hello' ? 'mismatch' : 'unproven');
    const startTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (phase === 'hello' && connected && received === 0 ? finish('no-answer') : failed()), timeoutMs);
      timer.unref?.();
    };
    startTimer();
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFERED_BYTES) return failed();
      for (let newline = buffer.indexOf('\n'); newline >= 0 && !done; newline = buffer.indexOf('\n')) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        step(line);
      }
    });
    socket.on('error', failed);
    socket.on('close', failed);

    // One line read: the hello, which earns the challenge, then the proof, which ends the probe.
    function step(line: string): void {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return failed(); }
      if (!isJsonObject(message)) return failed();
      if (phase === 'proof') {
        return finish(daemonAnswerProves(challenge, info.socketPath, message.codegraph_proof) ? 'proven' : 'unproven');
      }
      if (message.protocol !== 1 || message.pid !== info.pid || message.codegraph !== info.version) return failed();
      phase = 'proof';
      startTimer();
      socket.write(daemonChallengeLine(challenge));
    }
  });
}
