/**
 * The value of a Python path expression as pythonPathExpression evaluates it: normalized
 * segments, anchored on `__file__` (the segments are root-relative) or relative as written.
 *
 * Every step returns a new value, or null where the path is unknown or would raise: an
 * anchored path that climbs above the root, an anchored part joined onto a path (Python
 * would restart from it), a parent past the path's own.
 */

export class PathValue {
  constructor(readonly anchored: boolean, readonly segs: readonly string[]) {}

  /** The value with `part` ('/'-separated) appended: '' and '.' dropped, '..' taking a segment back. */
  push(part: string): PathValue | null {
    const segs = [...this.segs];
    for (const seg of part.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg !== '..') segs.push(seg);
      else if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop();
      else if (this.anchored) return null;
      else segs.push('..');
    }
    return new PathValue(this.anchored, segs);
  }

  /** `part` joined on; an anchored or unknown part gives null. */
  join(part: PathValue | null): PathValue | null {
    return part && !part.anchored ? this.push(part.segs.join('/')) : null;
  }

  /** `.parents[n]`, the (n+1)-th parent; null past the path's own parents, as Python raises. */
  parent(n: number): PathValue | null {
    return n < this.segs.length ? new PathValue(this.anchored, this.segs.slice(0, -n - 1)) : null;
  }

  /** The first value with each of the rest joined on; null for none. */
  static joinAll([first, ...rest]: PathValue[]): PathValue | null {
    return rest.reduce<PathValue | null>((acc, part) => acc && acc.join(part), first ?? null);
  }
}
