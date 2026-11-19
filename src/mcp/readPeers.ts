import { parseChallengeOrHello } from './parseChallengeOrHello';

/**
 * A client's peers, from its client hello. Every CodeGraph client (the proxy,
 * the CLI's builder route and its release request) first sends a challenge line
 * and waits for the proof before it says who it is, so a first line that is a
 * challenge is answered at once through `answerChallenge`, ahead of the anchor
 * lookup and the session, and the line after it is read as the client hello. A
 * first line that is a client hello is still read as one, and gets no proof
 * line. `readLine` reads one line with the parser it is given, `none` when the
 * line is missing or the parser refuses it.
 */
export async function readPeers<P extends object>(
  readLine: <T>(parse: (line: string) => T | null, none: T) => Promise<T>,
  parseHello: (line: string) => P | null,
  none: P,
  answerChallenge: (challenge: string) => void,
): Promise<P> {
  // The challenge is checked first: a challenge line is no client hello and
  // would otherwise go back to the transport as JSON-RPC.
  const first = await readLine<{ challenge: string } | P>((line) => parseChallengeOrHello(line, parseHello), none);
  if (!('challenge' in first)) return first;
  answerChallenge(first.challenge);
  return readLine(parseHello, none);
}
