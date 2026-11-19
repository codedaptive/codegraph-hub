/**
 * The local `use` a bare Rust path head is bound by (rustPathTarget): `fn f() {
 * use crate::b as a; a::take() }` makes `a` `crate::b`. A head bound by a
 * local alias whose own head is again a local alias is followed down the
 * chain, each alias read where its `use` is written, since a binding nearer
 * the reference does not change what an earlier import names. A `use` never
 * binds its own head (`use a;` names the module `a`), so following stops at a
 * binding that holds the `use` being read. A `mod` of the head's name declared
 * in a block of the same module nearer than the use's own block is that
 * block's own item, so the path is the `mod`'s, not the `use`'s, and the head
 * is declined; with no local `use` binding the head, or only the `use` being
 * read (`use a;`), any enclosing block-local `mod` of its name declines it. Pure: the caller supplies the bindings and the
 * inline modules.
 */

interface Path { segs: string[]; at: number }
interface Binding<P extends Path> { paths: P[]; std: readonly unknown[]; block: number }
interface ModBlock { name: string; scope?: { open: number; close: number }; parent: unknown }

/** The alias chain so far: the expanded path and its head, the position it was last read at, and the `use` read there. */
interface Walk<P extends Path> { path: string[]; head: string; at: number; via?: P }

const isPathRoot = (s: string): boolean => s === 'crate' || s === 'self' || s === 'super';

const stdOnly = (b: Binding<Path>): boolean => b.std.length > 0 && b.paths.length === 0;

const localUse = <B extends Binding<Path>>(b: B | undefined): b is B => b !== undefined && b.block >= 0 && b.paths.length > 0;

/** A `mod` named `head` declared in a block of `fromBlock` that opens after `after` and encloses `at`. */
function nearerMod(blocks: readonly ModBlock[], fromBlock: unknown, head: string, after: number, at: number): boolean {
  return blocks.some((b) => b.name === head && b.scope !== undefined && b.parent === fromBlock &&
    b.scope.open > after && b.scope.open < at && at < b.scope.close);
}

/**
 * Expands `walk` through `bound`'s one path. 'stop' when there is nothing to
 * follow (a split first binding, a path from `crate`, `self` or `super`); null
 * when a later binding splits or the chain comes back to a `use` it read.
 */
function step<P extends Path>(walk: Walk<P>, bound: Binding<P>, isFirst: boolean, seen: Set<string>): 'go' | 'stop' | null {
  const via = bound.paths[0];
  if (!via || bound.paths.some((p) => p.segs.join('::') !== via.segs.join('::'))) return isFirst ? 'stop' : null;
  const key = `${walk.head}\0${via.at}`;
  if (seen.has(key)) return null;
  seen.add(key);
  walk.path = [...via.segs, ...walk.path.slice(1)];
  walk.head = walk.path[0] ?? '';
  walk.at = via.at;
  walk.via = via;
  return isPathRoot(walk.head) ? 'stop' : 'go';
}

/** Follows local aliases from `first`; null when the chain cycles, splits past the first binding, or ends in std. */
function followAliases<P extends Path>(
  walk: Walk<P>, first: Binding<P> | undefined, visible: (name: string, at: number) => Binding<P> | undefined,
  blocks: readonly ModBlock[], fromBlock: unknown,
): Walk<P> | null {
  const seen = new Set<string>();
  let bound = first;
  while (bound && bound.block !== -1 && !nearerMod(blocks, fromBlock, walk.head, bound.block, walk.at)) {
    const next = step(walk, bound, bound === first, seen);
    if (next !== 'go') return next === null ? null : walk;
    bound = visible(walk.head, walk.at);
    if (bound?.paths.some((p) => p.at === walk.at)) break;
    if (bound && stdOnly(bound)) return null;
  }
  return walk;
}

/**
 * The block of the local `use` binding `end.head` at `end.at` (`first` when the
 * walk never moved), or -1: a path root has no such `use`, and a `use` holding
 * a path at `end.at` is the one being read, which never binds its own head.
 */
function useBlock<P extends Path>(
  end: Walk<P>, first: Binding<P> | undefined, visible: (name: string, at: number) => Binding<P> | undefined,
): number {
  if (isPathRoot(end.head)) return -1;
  const own = end.via ? visible(end.head, end.at) : first;
  return localUse(own) && !own.paths.some((p) => p.at === end.at) ? own.block : -1;
}

/**
 * The binding a bare head `head` at `offset` takes from a local `use`, with
 * its local aliases expanded when `follow`: null when the head must not
 * resolve (bound to std alone, a `mod` of its name nearer than the use's own
 * block, or any enclosing block-local `mod` when the only `use` is the one being
 * read (`use a;`), an alias cycle, a later alias that splits), undefined when no local
 * `use` binds it.
 */
export function rustHeadUse<P extends { segs: string[]; at: number }>(
  head: string, offset: number, follow: boolean,
  visible: (name: string, at: number) => { paths: P[]; std: readonly unknown[]; block: number } | undefined,
  blocks: readonly { name: string; scope?: { open: number; close: number }; parent: unknown }[], fromBlock: unknown,
): { paths: P[]; std: readonly unknown[]; block: number } | null | undefined {
  const first = visible(head, offset);
  if (first && stdOnly(first)) return null;
  const start: Walk<P> = { path: [head], head, at: offset };
  const end = follow ? followAliases(start, first, visible, blocks, fromBlock) : start;
  if (end === null || nearerMod(blocks, fromBlock, end.head, useBlock(end, first, visible), end.at)) return null;
  if (end.via && first) return { paths: [{ ...end.via, segs: end.path }], std: [], block: first.block };
  return localUse(first) ? first : undefined;
}
