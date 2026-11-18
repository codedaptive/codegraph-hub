/**
 * `value` as JSON carries it: properties whose value is undefined are dropped. A job body returns its result
 * through this, so the result is the same whether the job's child sends it over IPC or a runner calls the body
 * in the builder's process.
 */
export function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
