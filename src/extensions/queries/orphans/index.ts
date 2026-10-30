/**
 * Entry points for `codegraph orphans`: `runOrphans` (the command, returning
 * what the CLI prints) and `orphansToolHandler` (the MCP-shaped handler). The
 * rules (what "added" means, the orphan and guess predicates, the exclusions)
 * are `./orphans.ts`'s header.
 *
 * `--base` is required: "added" needs a pre-image commit, the merge base of
 * the base ref and HEAD, so there is no working-tree default as blast has.
 *
 * Both are async: the text-mention check's search runs through grep-by-symbol's `grepIndex`
 * (`../grep/grep-core.ts`), which spawns ripgrep.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDatabasePath } from '../../../db';
import { changedFiles, refExists } from '../blast/diff';
import { GrepIndexError, grepIndex } from '../grep/grep-core';
import { git } from '../shared/git';
import { validatePathWithinRoot } from '../../../utils';
import { findOrphans, MentionSearchIncompleteError, type OrphansIO } from './orphans';
import { jsonReport, textReport } from './render';
import { openOrphansStore } from './store';

export { findOrphans } from './orphans';
export type {
  OrphansReport, OrphanEntry, GuessedEntry, GuessEdge, UnresolvedEvidence, MentionEvidence,
} from './orphans';

export interface OrphansArgs {
  base?: string;
  format?: string;
}

export interface OrphansResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

function fail(message: string): OrphansResult {
  return { output: '', exitCode: 1, stderr: message };
}

/**
 * Run orphans at `root` and return what the CLI would print. Checks, in order:
 * base given, format, index, base ref known, merge base, diff. Failures carry
 * their message in `stderr` and exit 1; the report goes to `output`. A
 * ripgrep that cannot be started (the text-mention check's search), or a
 * text-mention check that cannot finish for a name (`MentionSearchIncompleteError`),
 * is a failure too: without the search, `orphaned` would claim more than was checked.
 * An indexed file the search cannot read is not a failure: the report counts it
 * (`searchUnread`) and the text says a mention there would be missed.
 */
export async function runOrphans(root: string, args: OrphansArgs): Promise<OrphansResult> {
  const absRoot = path.resolve(root);
  if (args.base === undefined || args.base === '') {
    return fail('✗ --base <ref> is required: orphans lists the symbols added since the merge base of that ref and HEAD');
  }
  const base = args.base;
  const format = args.format ?? 'text';
  if (format !== 'text' && format !== 'json') return fail(`✗ format must be text or json, got "${format}"`);
  if (!fs.existsSync(getDatabasePath(absRoot))) {
    return fail(`✗ no CodeGraph index at ${absRoot} — run \`codegraph init\` first`);
  }
  // refExists refuses a ref beginning with `-`, so nothing below passes one to git as an option.
  if (!refExists(absRoot, base)) {
    return fail(`✗ base ref "${base}" is not in this checkout.\n` +
      '  In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`.');
  }
  const mergeBase = git(absRoot, ['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) return fail(`✗ "${base}" and HEAD have no merge base in ${absRoot}`);
  const diff = changedFiles(absRoot, base);
  if (!diff) return fail(`✗ could not read a diff in ${absRoot} — is this a git repository?`);

  const io: OrphansIO = {
    // Pre-image read: `./` makes the path relative to the cwd, the project root, which is
    // what `--relative` diff paths are relative to.
    preImage: (file) => git(absRoot, ['show', `${mergeBase}:./${file.oldPath ?? file.path}`]),
    // Source read: only a file whose real location is inside the project (the leak-safe
    // policy of the content-serving reads, #527). An indexed symlink leading outside, which
    // the indexer follows (#935), is refused like a missing file; grepIndex refuses it too.
    source: (rel) => {
      const safe = validatePathWithinRoot(absRoot, rel);
      if (safe === null) return null;
      try {
        return fs.readFileSync(safe, 'utf8');
      } catch {
        return null;
      }
    },
    // Text-mention check: grep-by-symbol's search over exactly the indexed files.
    // `truncated.files` counts the ones it could not read (missing, unreadable, leading
    // outside the project), which the report carries as `searchUnread`.
    search: async (pattern, maxHits) => {
      const r = await grepIndex(absRoot, pattern, { maxHits });
      return {
        hits: r.groups.flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line, text: h.text }))),
        truncated: r.truncated.hits > 0,
        unread: r.truncated.files,
      };
    },
  };
  const store = openOrphansStore(absRoot);
  try {
    const report = { basis: diff.basis, mergeBase, ...(await findOrphans(store, diff.files, io)) };
    const output = format === 'json' ? `${jsonReport(report)}\n` : textReport(report);
    return { output, exitCode: 0 };
  } catch (err) {
    if (err instanceof GrepIndexError || err instanceof MentionSearchIncompleteError) return fail(`✗ ${err.message}`);
    throw err;
  } finally {
    store.close();
  }
}

/**
 * MCP-shaped handler. Expected failures (no base, unknown ref, no index, not a
 * git repo) come back as ordinary text guidance and never set `isError`: an
 * agent that sees an error early stops calling the tool (AGENTS.md, "Errors
 * teach abandonment").
 */
export async function orphansToolHandler(params: {
  projectPath: string;
  base?: string;
  format?: string;
}): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const r = await runOrphans(params.projectPath, { base: params.base, format: params.format });
  const text = r.exitCode === 0 ? r.output : (r.stderr ?? r.output);
  return { content: [{ type: 'text', text }] };
}
