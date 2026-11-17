/**
 * The stopped-index line `codegraph grep`, `blast` and `orphans` print first on stderr (S-71): host's note
 * (../../host/builder/stopped-index-note.ts) for host's mark of the root (../../host/builder/stopped-root-mark.ts),
 * after the CLI's yellow warn glyph, as src/bin/codegraph.ts prints it for its own read commands. The commands
 * print it only on a non-error answer (exit 0), matching host's one note per non-error answer.
 *
 * The CLI's `chalk.yellow` is private to codegraph.ts, so its form is reproduced here for these three commands.
 * Known gap: codegraph.ts strips `--color`/`--no-color` from process.argv when it loads, so this call-time check
 * sees only NO_COLOR, FORCE_COLOR, the TTY and CI.
 */
import { stoppedIndexNote } from '../../host/builder/stopped-index-note';
import { stoppedRootMark } from '../../host/builder/stopped-root-mark';
import { ansiColorsEnabled } from '../../../ui/color';
import { getGlyphs } from '../../../ui/glyphs';

function yellow(s: string): string {
  return ansiColorsEnabled() ? `\x1b[33m${s}\x1b[0m` : s;
}

/** The warning line, newline-terminated, when `root` carries a stopped mark; null otherwise. Never throws. */
export function stoppedIndexWarning(root: string): string | null {
  const mark = stoppedRootMark(root);
  return mark ? `${yellow(getGlyphs().warn)} ${stoppedIndexNote(mark)}\n` : null;
}
