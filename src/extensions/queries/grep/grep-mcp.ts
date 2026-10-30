/**
 * The `codegraph_grep` MCP tool's handler: it shapes the tool's inputs and
 * outputs. The definition is `GREP_TOOL` in `./grep-definition`;
 * `../extension.ts` registers both with the server through the extension hook
 * (src/extensions/host).
 *
 * Every expected condition (zero hits, bad pattern, unknown --in prefix, a
 * project with no index, a `strict` that is neither a boolean nor null/absent)
 * answers success-shaped guidance: an isError early in a session teaches the
 * agent to stop calling codegraph (AGENTS.md, "errors teach abandonment"). isError is kept for a security refusal (a project path
 * under a sensitive directory, as validateProjectPath decides) and a real
 * malfunction: ripgrep missing, or an unexpected failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findNearestCodeGraphRoot } from '../../../directory';
import { validateProjectPath } from '../../../utils';
import { GrepIndexError, GrepPatternError, GrepScopeError, grepIndex } from './grep-core';
import { formatGrepResult, zeroHitNote } from './grep-format';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (t: string, isError = false): ToolResult =>
  isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };

/**
 * The root to search, or a refusal. As ToolHandler does for every codegraph
 * tool: a path that exists is checked with validateProjectPath before
 * anything is opened (a path that does not exist yet may still walk up to its
 * project, so it is not checked as spelled), and the indexed root the walk
 * lands on is checked too, so a missing sub-path cannot walk up into an index
 * of a sensitive directory. With no index above it, the path itself is
 * returned so the not-indexed guidance names it.
 */
function resolveRoot(p: string): { root: string } | { refusal: string } {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    const refusal = validateProjectPath(abs);
    if (refusal) return { refusal };
  }
  const found = findNearestCodeGraphRoot(abs);
  if (found === null) return { root: abs };
  const refusal = validateProjectPath(found);
  return refusal ? { refusal } : { root: found };
}

export async function handleGrepTool(args: Record<string, unknown>, defaultProjectRoot?: string): Promise<ToolResult> {
  const pattern = args.pattern;
  if (typeof pattern !== 'string') return text('codegraph_grep needs a `pattern` string (a regex, or a literal with fixed: true).');
  const projectPath = typeof args.projectPath === 'string' && args.projectPath !== '' ? args.projectPath : defaultProjectRoot;
  if (projectPath === undefined) {
    return text('No project to search: pass `projectPath` pointing into a project that has a .codegraph/ index.');
  }
  // null is absent, as blast treats it (its absent() convention); any other non-boolean gets guidance.
  if (args.strict !== undefined && args.strict !== null && typeof args.strict !== 'boolean') {
    return text('strict must be true or false.');
  }
  const resolved = resolveRoot(projectPath);
  if ('refusal' in resolved) return text(resolved.refusal, true);
  const root = resolved.root;
  try {
    const result = await grepIndex(root, pattern, {
      in: typeof args.in === 'string' ? args.in : undefined,
      fixed: args.fixed === true,
      ignoreCase: args.ignore_case === true,
      strict: args.strict === true,
    });
    if (args.json === true) return text(JSON.stringify(result, null, 2));
    if (result.totalHits === 0) return text(zeroHitNote(result));
    return text(formatGrepResult(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof GrepPatternError) {
      return text(`invalid pattern "${pattern}": ${message}. Fix the regex, or pass fixed: true to search for it literally.`);
    }
    if (err instanceof GrepScopeError) return text(`${message}. Pass a repo-relative path prefix that holds indexed files, or omit \`in\`.`);
    if (err instanceof GrepIndexError && err.reason === 'not-indexed') {
      return text(`${message}. Pass \`projectPath\` pointing into a project that has a .codegraph/ index.`);
    }
    return text(`grep failed: ${message}. Retry once; if it fails again, codegraph_grep is unavailable here.`, true);
  }
}
