/**
 * The stopped-index line `codegraph grep`, `blast` and `orphans` print first on stderr (S-71): host's note
 * (../../host/builder/stopped-index-note.ts) for host's mark of the root (../../host/builder/stopped-root-mark.ts),
 * after the CLI's yellow warn glyph, as src/bin/codegraph.ts prints it for its own read commands. The commands
 * print it only on a non-error answer (exit 0), matching host's one note per non-error answer.
 *
 * The CLI's `chalk.yellow` is private to codegraph.ts, so its form is reproduced here for these three commands.
 * Whether it is coloured is the CLI's one colour decision (../../host/color/cliColorsEnabled.ts), which codegraph.ts
 * records before it strips `--color`/`--no-color` from process.argv, so the flags apply here too.
 */
import { stoppedIndexNote } from '../../host/builder/stopped-index-note';
import { stoppedRootMark } from '../../host/builder/stopped-root-mark';
import { cliColorsEnabled } from '../../host/color/cliColorsEnabled';
import { getGlyphs } from '../../../ui/glyphs';

function yellow(s: string): string {
  return cliColorsEnabled() ? `\x1b[33m${s}\x1b[0m` : s;
}

/** The warning line, newline-terminated, when `root` carries a stopped mark; null otherwise. Never throws. */
export function stoppedIndexWarning(root: string): string | null {
  const mark = stoppedRootMark(root);
  return mark ? `${yellow(getGlyphs().warn)} ${stoppedIndexNote(mark)}\n` : null;
}
