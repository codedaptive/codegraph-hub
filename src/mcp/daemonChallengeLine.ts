/**
 * The one line a client writes after the server's hello: a fresh challenge the
 * server must answer with its proof (see `./daemon-proof`) before the client
 * says who it is.
 */
export function daemonChallengeLine(challenge: string): string {
  return JSON.stringify({ codegraph_challenge: challenge }) + '\n';
}
