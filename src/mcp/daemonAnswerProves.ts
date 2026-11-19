import { daemonProofMatches, readDaemonKey } from './daemon-proof';

/**
 * Whether `proof` is this user's server answering `challenge` on `socketPath`
 * (see `./daemon-proof`). The key is read on each call, after the answer is in:
 * the server answering the first challenge is what makes the key, so a key
 * read before the challenge went out could be missing.
 */
export function daemonAnswerProves(challenge: string, socketPath: string, proof: unknown): boolean {
  const key = readDaemonKey();
  return key !== null && daemonProofMatches(key, challenge, socketPath, proof);
}
