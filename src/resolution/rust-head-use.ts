/**
 * The local `use` a bare Rust path head is bound by (rustPathTarget): `fn f() {
 * use crate::b as a; a::take() }` makes `a` `crate::b`. A head bound by a
 * local alias whose own head is again a local alias is followed down the
 * chain, each alias read where its `use` is written, since a binding nearer
 * the reference does not change what an earlier import names. A `mod` of the
 * head's name declared in a nearer block of the same module is that block's
 * own item, so the path is the `mod`'s, not the `use`'s, and the head is
 * declined. Pure: the caller supplies the bindings and the inline modules.
 */

/** One path a `use` names, by its segments and the offset of its `use`. */
export interface RustHeadPath {
  segs: string[];
  at: number;
}

/** The `use`s that bind a name at a position, as rustVisibleUse reads them. */
export interface RustHeadBinding<P extends RustHeadPath = RustHeadPath> {
  paths: P[];
  std: readonly unknown[];
  /** The `{` of the block they are written in, or -1 for the module's own. */
  block: number;
}

/** An inline `mod`, with the braces of the block it is declared in, if any. */
export interface RustHeadModBlock {
  name: string;
  scope?: { open: number; close: number };
  parent: unknown;
}

type Visible<P extends RustHeadPath> = (name: string, at: number) => RustHeadBinding<P> | undefined;

/** Where following stopped: the head and position last read, and the binding it expands to when any alias was followed. */
interface HeadEnd<P extends RustHeadPath> {
  head: string;
  at: number;
  expanded?: RustHeadBinding<P>;
}

const isPathRoot = (s: string): boolean => s === 'crate' || s === 'self' || s === 'super';

const stdOnly = (b: RustHeadBinding<RustHeadPath>): boolean => b.std.length > 0 && b.paths.length === 0;

/** A `mod` named `head` declared in a block of `fromBlock` that opens after `after` and encloses `at`. */
function nearerMod(blocks: readonly RustHeadModBlock[], fromBlock: unknown, head: string, after: number, at: number): boolean {
  return blocks.some((b) => b.name === head && b.scope !== undefined && b.parent === fromBlock &&
    b.scope.open > after && b.scope.open < at && at < b.scope.close);
}

/** Follows local aliases from `first`; null when the chain cycles, splits past the first binding, or ends in std. */
function followAliases<P extends RustHeadPath>(
  head: string, offset: number, first: RustHeadBinding<P> | undefined, visible: Visible<P>,
  blocks: readonly RustHeadModBlock[], fromBlock: unknown,
): HeadEnd<P> | null {
  const seen = new Set<string>();
  let path = [head];
  let cur = head;
  let at = offset;
  let lastVia: P | undefined;
  let bound = first;
  while (bound && bound.block !== -1) {
    if (nearerMod(blocks, fromBlock, cur, bound.block, at)) break;
    const via = bound.paths[0];
    if (!via || bound.paths.some((p) => p.segs.join('::') !== via.segs.join('::'))) {
      if (bound === first) break;
      return null;
    }
    const key = `${cur}\0${via.at}`;
    if (seen.has(key)) return null;
    seen.add(key);
    path = [...via.segs, ...path.slice(1)];
    cur = path[0] ?? '';
    at = via.at;
    lastVia = via;
    if (isPathRoot(cur)) break;
    bound = visible(cur, at);
    if (bound && stdOnly(bound)) return null;
  }
  const expanded = lastVia && first ? { paths: [{ ...lastVia, segs: path }], std: [], block: first.block } : undefined;
  return { head: cur, at, expanded };
}

/**
 * The binding a bare head `head` at `offset` takes from a local `use`, with
 * its local aliases expanded when `follow`: null when the head must not
 * resolve (bound to std alone, a nearer `mod` of its name, an alias cycle, a
 * later alias that splits), undefined when no local `use` binds it.
 */
export function rustHeadUse<P extends RustHeadPath>(
  head: string, offset: number, follow: boolean, visible: Visible<P>,
  blocks: readonly RustHeadModBlock[], fromBlock: unknown,
): RustHeadBinding<P> | null | undefined {
  const first = visible(head, offset);
  if (first && stdOnly(first)) return null;
  const end: HeadEnd<P> | null = follow ? followAliases(head, offset, first, visible, blocks, fromBlock) : { head, at: offset };
  if (end === null || nearerMod(blocks, fromBlock, end.head, -1, end.at)) return null;
  if (end.expanded) return end.expanded;
  return first && first.block >= 0 && first.paths.length > 0 ? first : undefined;
}
