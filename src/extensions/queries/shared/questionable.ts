/**
 * Questionable call edges: the `calls` edges the resolver bound by NAME ONLY.
 * grep (its in-degree counts) and blast (its walk) mark them, and leave them
 * out under `--strict` / `strict: true`.
 *
 * The predicate is resolution's CANDIDATE EDGE, copied from the header of
 * src/extensions/resolution/suspects.ts (and its candidate SQL): kind =
 * 'calls' and `metadata.resolvedBy` is 'exact-match' or 'fuzzy', or is
 * 'instance-method' with confidence below 0.9 (a missing or non-numeric
 * confidence counts as 1, a JSON boolean as 1/0, as SQLite's json_extract
 * reads it). An edge with no resolvedBy (extraction-local, synthesized) is not
 * questionable. suspects.ts exports no per-edge predicate or SQL fragment, so
 * this module carries its own copy.
 * Keep the two forms below in step with each other and with suspects.ts.
 */

/** An instance-method edge at or above this had a declared receiver type (suspects.ts DECLARED_INSTANCE_CONFIDENCE). */
export const DECLARED_INSTANCE_CONFIDENCE = 0.9;

/**
 * SQL boolean expression, true for a questionable edge of the `edges` row
 * named `alias` (a table name or alias with `kind` and `metadata` columns).
 * `alias` is interpolated, so pass only a literal identifier, never input.
 */
export function questionableCallSql(alias: string): string {
  const by = `json_extract(${alias}.metadata, '$.resolvedBy')`;
  return (
    `(${alias}.kind = 'calls' AND ${by} IS NOT NULL AND (${by} IN ('exact-match', 'fuzzy')` +
    ` OR (${by} = 'instance-method' AND COALESCE(json_extract(${alias}.metadata, '$.confidence'), 1) < ${DECLARED_INSTANCE_CONFIDENCE})))`
  );
}

/**
 * The same predicate over an edge's kind and parsed metadata (null when the
 * edge has none). The confidence is read as the SQL form's
 * `COALESCE(json_extract(...), 1) < 0.9` reads it, so the two never disagree:
 * a number is itself; a JSON boolean is 1 (true) or 0 (false), as json_extract
 * returns it; anything else (null, absent, a string, an object) counts as 1. A
 * string is not parsed: json_extract keeps it TEXT, and SQLite orders TEXT
 * above every number, so '0.5' is not below 0.9.
 */
export function isQuestionableCall(kind: string, metadata: Record<string, unknown> | null | undefined): boolean {
  if (kind !== 'calls' || !metadata) return false;
  const by = metadata.resolvedBy;
  if (by === 'exact-match' || by === 'fuzzy') return true;
  if (by !== 'instance-method') return false;
  const c = metadata.confidence;
  const confidence = typeof c === 'number' ? c : typeof c === 'boolean' ? (c ? 1 : 0) : 1;
  return confidence < DECLARED_INSTANCE_CONFIDENCE;
}
