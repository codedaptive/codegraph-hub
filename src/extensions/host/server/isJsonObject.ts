/**
 * Whether a parsed JSON value is an object: not null, not an array and not a scalar. Every line of the machine
 * server's protocol is one, so a line that parses to anything else is not that server's.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
