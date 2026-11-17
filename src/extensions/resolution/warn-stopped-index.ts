/**
 * The stopped-index warning for `codegraph suspects` (S-71): when the index builder's last job of `root` was
 * stopped at a limit, one line on stderr, the CLI's warn glyph (yellow when the CLI prints colour) and host's
 * stoppedIndexNote. Stderr, not stdout, so the answer on stdout, `--json` included, stays parseable. No mark
 * means nothing is written. The mark lookup and the note text are host's (../host/builder).
 *
 * Loaded only with `await import`, by registerSuspectsCommand in ./extension.ts, so its imports stay off the
 * CLI's start-up path.
 */
import { stoppedRootMark } from '../host/builder/stopped-root-mark';
import { stoppedIndexNote } from '../host/builder/stopped-index-note';
import { getGlyphs } from '../../ui/glyphs';
import { ansiColorsEnabled } from '../../ui/color';

export async function warnStoppedIndex(root: string): Promise<void> {
  const mark = stoppedRootMark(root);
  if (!mark) return;
  const glyph = getGlyphs().warn;
  process.stderr.write(`${ansiColorsEnabled() ? `\x1b[33m${glyph}\x1b[0m` : glyph} ${stoppedIndexNote(mark)}\n`);
}
