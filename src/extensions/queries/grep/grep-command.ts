/**
 * CLI-shaped entry for grep-by-symbol. It returns the output instead of
 * printing and exiting, so
 * the caller only writes the streams and sets the exit code.
 */
import * as path from 'path';
import { findNearestCodeGraphRoot } from '../../../directory';
import { GrepIndexError, GrepPatternError, GrepScopeError, grepIndex, type GrepOptions } from './grep-core';
import { formatGrepResult, zeroHitNote } from './grep-format';

export interface CommandOutput { stdout: string; stderr: string; exitCode: number }

export const GREP_USAGE =
  'usage: codegraph grep <pattern> [--in <path>] [--fixed] [-i|--ignore-case] [--strict] [--json] [-p|--path <projectRoot>]\n' +
  '  (put -- before a pattern that starts with "-"; --strict leaves name-matched calls out of the in-edge counts)\n';

interface ParsedArgs { pattern?: string; opts: GrepOptions; json: boolean; projectPath?: string }

/** Parse argv (without the program and the word "grep"). Returns an error message instead of throwing. */
function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { opts: {}, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--in': {
        const v = value();
        if (v === undefined) return { error: '--in needs a path' };
        out.opts.in = v;
        break;
      }
      case '-p':
      case '--path': {
        const v = value();
        if (v === undefined) return { error: `${flag} needs a project root` };
        out.projectPath = v;
        break;
      }
      case '--fixed':
        out.opts.fixed = true;
        break;
      case '-i':
      case '--ignore-case':
        out.opts.ignoreCase = true;
        break;
      case '--strict':
        out.opts.strict = true;
        break;
      case '--json':
        out.json = true;
        break;
      default:
        if (a.startsWith('-') && a.length > 1) return { error: `unknown option ${a}` };
        positional.push(a);
    }
  }
  if (positional.length === 0) return { error: 'missing <pattern>' };
  if (positional.length > 1) return { error: `one pattern only (got ${positional.length})` };
  out.pattern = positional[0];
  return out;
}

/**
 * Run `grep` with CLI semantics: exit 1 with a `✗` line on stderr for a bad
 * pattern, an unknown `--in` prefix or a missing index; exit 0 otherwise.
 * The project root is `--path` when given, else the nearest ancestor of `cwd`
 * holding an index.
 * Zero hits is not an error: text mode puts the note on stderr and exits 0.
 */
export async function runGrepCommand(argv: string[], cwd: string): Promise<CommandOutput> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) return { stdout: '', stderr: `✗ ${parsed.error}\n${GREP_USAGE}`, exitCode: 1 };
  const pattern = parsed.pattern as string;

  const root = parsed.projectPath !== undefined ? path.resolve(cwd, parsed.projectPath) : findNearestCodeGraphRoot(cwd);
  try {
    if (root === null) {
      throw new GrepIndexError(`no codegraph index at or above ${cwd} — run codegraph init in the project first`, 'not-indexed');
    }
    const result = await grepIndex(root, pattern, parsed.opts);
    if (parsed.json) return { stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 };
    if (result.totalHits === 0) return { stdout: '', stderr: zeroHitNote(result) + '\n', exitCode: 0 };
    return { stdout: formatGrepResult(result), stderr: '', exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof GrepPatternError) return { stdout: '', stderr: `✗ invalid pattern "${pattern}": ${message}\n`, exitCode: 1 };
    if (err instanceof GrepScopeError || err instanceof GrepIndexError) return { stdout: '', stderr: `✗ ${message}\n`, exitCode: 1 };
    throw err;
  }
}
