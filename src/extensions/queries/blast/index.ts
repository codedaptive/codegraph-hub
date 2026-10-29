/**
 * Entry points for `codegraph blast`: `runBlast` (the command), `blastToolHandler`
 * (the MCP-shaped handler) and `parseBlastArgv` (the CLI flag parser).
 *
 * A port of graft 0.16 `dist/blast/blast-cli.js`: the same depth and format
 * grammar (`resolveDepth`, `resolveFormat`) and graft's order of checks after
 * a flag parse error, which fails first, with graft's `process.exit(1)` turned
 * into a returned exit code so the chain stays testable without a subprocess.
 * The error wording is graft's except three: a flag parse error's ("needs a
 * value") is this port's own, the no-index message points at `codegraph init`,
 * and the format list has no `mermaid`.
 *
 * Deliberately left out: `--format mermaid`, `--name`, owners and
 * `--pr-author`, `--export-viz`/`--title`, and graft's `--global-dir`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../../../db';
import { blastRadius } from './blast';
import { changedFiles, refExists } from './diff';
import { jsonReport, markdownReport, textReport } from './render';
import { openBlastStore } from './store';

export interface BlastArgs {
  base?: string;
  depth?: string | number;
  format?: string;
  /**
   * Set by `parseBlastArgv` when a flag has no value. `runBlast` fails with it
   * before any other check, so a dropped value never runs the default comparison.
   */
  error?: string;
}

export interface BlastResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

type Format = 'text' | 'json' | 'markdown';

/** graft's default walk depth: direct dependents and their dependents. */
const DEFAULT_DEPTH = 2;

function fail(message: string): BlastResult {
  return { output: '', exitCode: 1, stderr: message };
}

function resolveFormat(raw: string | undefined): Format | BlastResult {
  if (raw === undefined) return 'text';
  if (raw === 'text' || raw === 'markdown' || raw === 'json') return raw;
  return fail(`✗ --format must be text, markdown or json, got "${raw}"`);
}

/** graft's grammar: all|full|max is the full closure; otherwise a number >= 1, floored. */
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
 * A flag parse error (`args.error`) fails first; the rest run in graft's order:
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
  // An unknown base is usually a shallow CI checkout, not a typo; graft's message says so.
  if (args.base !== undefined && !refExists(absRoot, args.base)) {
    return fail(`✗ base ref "${args.base}" is not in this checkout.\n` +
      '  In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`.');
  }
  const diff = changedFiles(absRoot, args.base);
  if (!diff) return fail(`✗ could not read a diff in ${absRoot} — is this a git repository?`);

  const store = openBlastStore(absRoot);
  try {
    const report = blastRadius(store, diff.files, diff.basis, depth);
    // graft prints JSON with console.log, hence the trailing newline; text and
    // markdown already end in one.
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
 * teach abandonment").
 */
export function blastToolHandler(params: {
  projectPath: string;
  base?: string;
  depth?: string | number;
  format?: string;
}): { content: [{ type: 'text'; text: string }] } {
  const r = runBlast(params.projectPath, { base: params.base, depth: params.depth, format: params.format });
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

/** `token` up to its first `=`, or all of it when it has none. */
function flagPart(token: string): string {
  const eq = token.indexOf('=');
  return eq < 0 ? token : token.slice(0, eq);
}

/**
 * Parse `--base X`/`-b X`, `--depth N|all`/`-d N`, `--format F`/`-f F`, each
 * also as `flag=value` (`--base=origin/main`). Only flags present are set; a
 * repeated flag keeps its last value; unknown tokens are ignored; validation
 * of the values is `runBlast`'s. A flag with no value — the last token, an
 * empty `flag=`, or followed by another known flag (`--base --depth 3`) — sets
 * `error` and stops parsing, and `runBlast` exits 1 with it. Any other next
 * token is taken as the value, so `--depth -1` reaches `runBlast` and is
 * rejected there.
 */
export function parseBlastArgv(argv: string[]): BlastArgs {
  const out: BlastArgs = {};
  for (let i = 0; i < argv.length; i++) {
    // `?? ''` only satisfies noUncheckedIndexedAccess; `i` is always in range.
    const token = argv[i] ?? '';
    const flag = flagPart(token);
    const field = FLAGS.get(flag);
    if (field === undefined) continue;
    let value: string | undefined;
    if (flag !== token) {
      value = token.slice(flag.length + 1);
    } else {
      value = argv[i + 1];
      if (value !== undefined && !FLAGS.has(flagPart(value))) i++;
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
