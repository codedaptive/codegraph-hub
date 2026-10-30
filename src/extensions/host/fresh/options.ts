/**
 * The `--fresh` / `--checkpoint` option text for the commands that answer from the index (query, explore,
 * node, callers, callees, impact), and the exit status for an answer from an index that is not fresh.
 *
 * No imports at all: src/bin/codegraph.ts imports this module statically, because `.option()` needs the
 * help text synchronously while the program is built, and every CLI invocation loads it. The logic is in
 * ./cli.ts (loaded with `await import`) and ./checkpoint.ts.
 */

/** The two flags, as commander parses them onto each of those commands' options. */
export interface FreshFlags { fresh?: boolean; checkpoint?: boolean }

/**
 * Exit status for an answer from an index that is not fresh. Distinct from 1 (error / not initialized)
 * and commander's usage errors, so a script can tell "answered from a stale index" from "failed".
 */
export const EXIT_NOT_FRESH = 3;

export const FRESH_OPTION_HELP = 'Bring the index up to date with the working tree before answering (bounded by CODEGRAPH_FRESH_TIMEOUT_MS, default 30000); exit 3 if files are still pending or the count is unknown (a sync error with nothing pending is fresh, exit 0). A sync still running at the bound is waited for after the answer is printed, before exit (bounded by CODEGRAPH_FRESH_SETTLE_TIMEOUT_MS, default 600000)';

export const CHECKPOINT_OPTION_HELP = 'Print the workspace state the answer reflects as one "codegraph-checkpoint <json>" line on stderr';
