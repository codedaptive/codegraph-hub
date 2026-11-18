/**
 * The items `path` names walked (`walk`, name-matcher's rustUsePathItems) from
 * `module`, else, when its head is not `crate`, `self` or `super`, from the
 * root of the crate `filePath` is in (`crateRoot`, name-matcher's
 * rustCrateRootModule): a 2015 path is crate-relative. Not when the module
 * declares a module of the head's name itself (`pathMods`): where its `#[path]`
 * puts it is the module's own choice (a cfg's), and another module of that name
 * at the root is not it.
 */
export function rustPathItemsOr2015<M, N, C>(
  path: readonly string[], module: M, pathMods: ReadonlySet<string>, filePath: string, context: C,
  walk: (path: readonly string[], from: M, context: C, seen: Set<string>) => N[] | null,
  crateRoot: (filePath: string, context: C) => M | null,
): N[] | null {
  const items = walk(path, module, context, new Set());
  const head = path[0] ?? '';
  if (items !== null || head === 'crate' || head === 'self' || head === 'super' || pathMods.has(head)) return items;
  const root = crateRoot(filePath, context);
  return root ? walk(path, root, context, new Set()) : null;
}
