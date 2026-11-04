/**
 * Entry points for `codegraph blast`: `runBlast` (the command), `blastToolHandler`
 * (the MCP-shaped handler) and `parseBlastArgv` (an argv parser for the same
 * flags; the real CLI parses with commander, in `./extension.ts`).
 *
 * Depth and format are validated after flag parsing. Failures return an exit
 * code and message, allowing callers to test the command without a subprocess.
 * `--strict` leaves out dependents reached only through questionable call edges.
 *
 * Under an MCP session started with `--focus`, `blastToolHandler` gives `runBlast`
 * the focus (`BlastArgs.focus`), and the report lists the dependents outside it
 * apart (`splitReportByFocus`, `./focus.ts`); the CLI has no session, never sets
 * it, and prints the unsplit report.
 *
 * Deliberately left out: `--format mermaid`, `--name`, owners and
 * `--pr-author`, `--export-viz`/`--title`, and `--global-dir`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../../../db';
import { blastRadius } from './blast';
import { changedFiles, refExists } from './diff';
import { focusDirsText, focusPrefixesOfTool } from '../shared/focus';
import { splitReportByFocus } from './focus';
import { jsonReport, markdownReport, textReport } from './render';
import { openBlastStore } from './store';

export interface BlastArgs {
  base?: string;
  depth?: string | number;
  format?: string;
  /** Leave out dependents reached only through questionable (name-matched) call edges. */
  strict?: boolean;
  /**
   * The session's active focus, as `blastToolHandler` resolves it for this index
   * (`focusPrefixesOfTool`, `focusDirsText`). Set only for an MCP call from a session
   * that has a focus; the CLI and an unfocused session leave it absent, and their
   * report carries no `outsideFocus`. `prefixes` is the membership rule: `null` when
   * the focus holds the whole index (nothing is outside it, the report still carries an
   * empty `outsideFocus`), otherwise the dependents outside the prefixes are listed apart.
   */
  focus?: { prefixes: readonly string[] | null; dirs: string };
  /**
   * Set by `parseBlastArgv` when a flag has no value or the `--strict` switch is
   * given one. `runBlast` fails with it before any other check, so a malformed
   * flag never runs the default comparison.
   */
  error?: string;
}

export interface BlastResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

type Format = 'text' | 'json' | 'markdown';

/** Default walk depth: direct dependents and their dependents. */
const DEFAULT_DEPTH = 2;

function fail(message: string): BlastResult {
  return { output: '', exitCode: 1, stderr: message };
}

function resolveFormat(raw: string | undefined): Format | BlastResult {
  if (raw === undefined) return 'text';
  if (raw === 'text' || raw === 'markdown' || raw === 'json') return raw;
  return fail(`✗ --format must be text, markdown or json, got "${raw}"`);
}

/** all|full|max is the full closure; otherwise a number >= 1, floored. */
function resolveDepth(raw: string | number | undefined): number | BlastResult {
  if (raw === undefined) return DEFAULT_DEPTH;
  const text = String(raw);
  if (/^(all|full|max)$/i.test(text)) return Number.POSITIVE_INFINITY;
  const d = Number(text);
  if (!Number.isFinite(d) || d < 1) return fail(`✗ --depth must be a positive number or "all", got "${text}"`);
  return Math.floor(d);
}

/**
 * Run blast at `root` and return what the CLI would print.
 *
 * A flag parse error (`args.error`) fails first; the remaining checks run in order:
 * format, depth, index, base ref, diff. Failures carry their message in
 * `stderr` and exit 1; the report goes to `output`.
 */
export function runBlast(root: string, args: BlastArgs): BlastResult {
  if (args.error !== undefined) return fail(args.error);
  const absRoot = path.resolve(root);
  const format = resolveFormat(args.format);
  if (typeof format !== 'string') return format;
  const depth = resolveDepth(args.depth);
  if (typeof depth !== 'number') return depth;

  if (!fs.existsSync(getDatabasePath(absRoot))) {
    return fail(`✗ no CodeGraph index at ${absRoot} — run \`codegraph init\` first`);
  }
  // An unknown base may be caused by a shallow CI checkout.
  if (args.base !== undefined && !refExists(absRoot, args.base)) {
    return fail(`✗ base ref "${args.base}" is not in this checkout.\n` +
      '  In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`.');
  }
  const diff = changedFiles(absRoot, args.base);
  if (!diff) return fail(`✗ could not read a diff in ${absRoot} — is this a git repository?`);

  const store = openBlastStore(absRoot);
  try {
    const whole = blastRadius(store, diff.files, diff.basis, depth, { strict: args.strict === true });
    const report = args.focus ? splitReportByFocus(whole, args.focus.prefixes, args.focus.dirs) : whole;
    // JSON gets a trailing newline; text and markdown already end in one.
    const output = format === 'json' ? `${jsonReport(report)}\n`
      : format === 'markdown' ? markdownReport(report)
        : textReport(report);
    return { output, exitCode: 0 };
  } finally {
    store.close();
  }
}

/**
 * MCP-shaped handler. Expected failures (no index, unknown ref, bad flag, not a
 * git repo) come back as ordinary text guidance and never set `isError`: an
 * agent that sees an error early stops calling the tool (AGENTS.md, "Errors
 * teach abandonment"). `sessionFocus` is the calling session's focus directories
 * (`ExtensionToolContext.focus`); absent or empty, the answer is the CLI's.
 * Blast covers the whole repository whatever the focus: a focus only moves the
 * dependents outside it under "Outside focus".
 */
export function blastToolHandler(params: {
  projectPath: string;
  base?: string;
  depth?: string | number;
  format?: string;
  strict?: boolean;
  sessionFocus?: readonly string[];
}): { content: [{ type: 'text'; text: string }] } {
  const absRoot = path.resolve(params.projectPath);
  const prefixes = focusPrefixesOfTool(absRoot, params.sessionFocus);
  // A session with a focus keeps it active even when the focus holds the whole index
  // (prefixes null): json then carries an empty `outsideFocus`. No session focus, no key.
  const focus = (params.sessionFocus ?? []).length === 0
    ? undefined
    : { prefixes, dirs: focusDirsText(absRoot, params.sessionFocus, prefixes ?? []) };
  const r = runBlast(params.projectPath, {
    base: params.base, depth: params.depth, format: params.format, strict: params.strict, focus,
  });
  const text = r.exitCode === 0 ? r.output : (r.stderr ?? r.output);
  return { content: [{ type: 'text', text }] };
}

/**
 * The flags `parseBlastArgv` reads, long and short, and the field each sets. A
 * Map, not an object literal, so a token such as `toString` matches nothing.
 */
const FLAGS = new Map<string, 'base' | 'depth' | 'format'>([
  ['--base', 'base'], ['-b', 'base'],
  ['--depth', 'depth'], ['-d', 'depth'],
  ['--format', 'format'], ['-f', 'format'],
]);

/** The value-less flags `parseBlastArgv` reads, and the field each sets to true. */
const SWITCHES = new Map<string, 'strict'>([['--strict', 'strict']]);

/** True when `token` is a flag or switch `parseBlastArgv` reads, so it cannot be another flag's value. */
function isKnownFlag(token: string): boolean {
  const flag = flagPart(token);
  return FLAGS.has(flag) || SWITCHES.has(flag);
}

/** `token` up to its first `=`, or all of it when it has none. */
function flagPart(token: string): string {
  const eq = token.indexOf('=');
  return eq < 0 ? token : token.slice(0, eq);
}

/**
 * Parse `--base X`/`-b X`, `--depth N|all`/`-d N`, `--format F`/`-f F`, each
 * also as `flag=value` (`--base=origin/main`), and the switch `--strict`, which
 * sets `strict: true` (absent, the key is absent). Only flags present are set; a
 * repeated flag keeps its last value; unknown tokens are ignored; validation
 * of the values is `runBlast`'s. A flag with no value — the last token, an
 * empty `flag=`, or followed by another known flag or switch (`--base --depth 3`,
 * `--base --strict`) — sets `error` and stops parsing, and `runBlast` exits 1
 * with it; so does a value given to the switch (`--strict=yes`). Any other next
 * token is taken as the value, so `--depth -1` reaches `runBlast` and is
 * rejected there.
 */
export function parseBlastArgv(argv: string[]): BlastArgs {
  const out: BlastArgs = {};
  for (let i = 0; i < argv.length; i++) {
    // `?? ''` only satisfies noUncheckedIndexedAccess; `i` is always in range.
    const token = argv[i] ?? '';
    const flag = flagPart(token);
    const toggle = SWITCHES.get(flag);
    if (toggle !== undefined) {
      if (flag !== token) {
        out.error = `✗ ${flag} takes no value`;
        return out;
      }
      out[toggle] = true;
      continue;
    }
    const field = FLAGS.get(flag);
    if (field === undefined) continue;
    let value: string | undefined;
    if (flag !== token) {
      value = token.slice(flag.length + 1);
    } else {
      value = argv[i + 1];
      if (value !== undefined && !isKnownFlag(value)) i++;
      else value = undefined;
    }
    if (value === undefined || value === '') {
      out.error = `✗ ${flag} needs a value`;
      return out;
    }
    out[field] = value;
  }
  return out;
}
