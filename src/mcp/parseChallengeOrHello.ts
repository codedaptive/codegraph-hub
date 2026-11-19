import { parseDaemonChallengeLine } from './parseDaemonChallengeLine';

/**
 * A client's first line on a server socket: `{ challenge }` when it is a challenge line, else what
 * `parseHello` makes of it (null when neither accepts it). The challenge is checked first, so a line both
 * would accept is read as a challenge and never handed on as a hello.
 */
export function parseChallengeOrHello<T>(
  line: string,
  parseHello: (line: string) => T | null,
): { challenge: string } | T | null {
  const challenge = parseDaemonChallengeLine(line);
  return challenge === null ? parseHello(line) : { challenge };
}
