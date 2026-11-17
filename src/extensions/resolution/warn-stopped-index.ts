/**
 * The stopped-index warning for `codegraph suspects` (S-71): when the index builder's last job of `root` was
 * stopped at a limit, one line on stderr, the warn glyph and host's stoppedIndexNote. The glyph is uncoloured:
 * the CLI's colour decision is private to src/bin/codegraph.ts. Stderr, not stdout, so the answer on stdout,
 * `--json` included, stays parseable. No mark
 * means nothing is written. The mark lookup and the note text are host's (../host/builder).
 *
 * Loaded only with `await import`, by registerSuspectsCommand in ./extension.ts, so its imports stay off the
 * CLI's start-up path.
 */
import { stoppedRootMark } from '../host/builder/stopped-root-mark';
import { stoppedIndexNote } from '../host/builder/stopped-index-note';
import { getGlyphs } from '../../ui/glyphs';

export async function warnStoppedIndex(root: string): Promise<void> {
  const mark = stoppedRootMark(root);
  if (!mark) return;
  process.stderr.write(`${getGlyphs().warn} ${stoppedIndexNote(mark)}\n`);
}
