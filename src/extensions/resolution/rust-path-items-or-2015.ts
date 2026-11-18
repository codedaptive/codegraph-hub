/**
 * The items `path` names walked (`walk`) from `module`, else, when its head is
 * not `crate`, `self` or `super`, from the crate's root (`crateRoot`): a 2015
 * path is crate-relative. Not when the module declares a module of the head's
 * name itself (`pathMods`): where its `#[path]` puts it is the module's own
 * choice (a cfg's), and another module of that name at the root is not it.
 */
export function rustPathItemsOr2015<M, N>(
  path: readonly string[], module: M, pathMods: ReadonlySet<string>,
  walk: (path: readonly string[], from: M) => N[] | null,
  crateRoot: () => M | null,
): N[] | null {
  const items = walk(path, module);
  const head = path[0] ?? '';
  if (items !== null || head === 'crate' || head === 'self' || head === 'super' || pathMods.has(head)) return items;
  const root = crateRoot();
  return root ? walk(path, root) : null;
}
