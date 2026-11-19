/**
 * What pythonPathExpression may rely on in the file an expression comes from: whether
 * `__file__` is the module's own path, and which words it may call through. A type alone,
 * made by pythonTrust and read by pythonPathExpression, so it lives in neither.
 */

export interface PathTrust {
  /** True when nothing in the file may rebind `__file__`. */
  file: boolean;
  /** The bare callees (Path, join, …) it may call through. */
  names: ReadonlySet<string>;
  /** The words (os, path, join, …) a dotted callee it may call through can be made of. */
  dotted: ReadonlySet<string>;
}
