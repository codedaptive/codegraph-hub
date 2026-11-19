import { MAX_CHALLENGE_LENGTH } from './daemon-proof';

/**
 * The challenge in a client's challenge line (`{"codegraph_challenge":"…"}`,
 * see `./daemonChallengeLine`): a string of 1 to MAX_CHALLENGE_LENGTH
 * characters. Null for any other line, which the server reads as no challenge.
 */
export function parseDaemonChallengeLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('codegraph_challenge' in parsed)) return null;
  const challenge = parsed.codegraph_challenge;
  if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > MAX_CHALLENGE_LENGTH) return null;
  return challenge;
}
