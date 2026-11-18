/**
 * The check every job of a held root (./holder.ts) runs first: throws unless the hold is open and owns
 * `writer.pid`, so a job of a released hold refuses to run.
 */
export function requireWritable(hold: { root: string; closed: boolean; owner: boolean }): void {
  if (hold.closed || !hold.owner) throw new Error(`${hold.root} was released by the index builder`);
}
