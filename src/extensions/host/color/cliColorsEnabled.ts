/**
 * The CLI's one colour decision for the whole run. src/bin/codegraph.ts strips
 * `--color` / `--no-color` from process.argv before commander parses, and
 * ansiColorsEnabled() (src/ui/color.ts) reads argv live, so a later call there
 * would no longer see the flags. The entry point calls cliColorsEnabled()
 * before that strip; the answer is recorded here, and every later caller (the
 * CLI, extension commands, other lanes) reads the same answer.
 *
 * Nothing is read at import. A process that never ran the CLI entry point
 * decides at its first call.
 */
import { ansiColorsEnabled } from '../../../ui/color';

let decided: boolean | undefined;

/** Whether the CLI prints ANSI colour; decided at the first call in the process. */
export function cliColorsEnabled(): boolean {
  decided ??= ansiColorsEnabled();
  return decided;
}
