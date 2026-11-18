/**
 * Evaluates statically the Python path expression an importlib loader is given, so the
 * loading module can be linked to the file it loads. Read: string literals, `__file__`,
 * Path()/PurePath()/str()/fspath()/abspath()/realpath()/normpath() (identity), dirname(),
 * join(), `/`, `.parent`, `.parents[N]`, `.resolve()`, `.absolute()`, `.joinpath()`, and
 * the module's single-assignment `names`, to a bounded depth so `A = B` / `B = A` ends.
 * A call is matched by its last dotted name only: `os.path.join` and `x.join` are alike.
 * Anything else is computed at run time and gives null: a guessed path is a false edge.
 * A path anchored on `__file__` comes back root-relative with a leading '/' (null when it
 * climbs above the root); any other is relative as written, normalized, with './'
 * prepended when it has no '/'. An absolute literal gives null.
 */
import type { PathToken } from './python-path-token';
import { pythonPathTokens } from './python-path-tokens';

interface PathValue {
  anchored: boolean;
  segs: string[];
}

/** Deep enough for ROOT -> SCRIPT -> its use; a cycle runs out of it. */
const MAX_DEPTH = 8;
const IDENTITY_CALLS = new Set(['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath']);
const IDENTITY_METHODS = new Set(['resolve', 'absolute']);

export function pythonPathExpression(expression: string, filePath: string, names: ReadonlyMap<string, string>): string | null {
  const value = evaluate(expression, filePath, names, MAX_DEPTH);
  if (!value || value.segs.length === 0) return null;
  const joined = value.segs.join('/');
  if (value.anchored) return `/${joined}`;
  return joined.includes('/') ? joined : `./${joined}`;
}

function evaluate(expression: string, filePath: string, names: ReadonlyMap<string, string>, depth: number): PathValue | null {
  const tokens = depth > 0 ? pythonPathTokens(expression) : null;
  return tokens && new Parser(tokens, filePath, names, depth).whole();
}

function push(value: PathValue, part: string): PathValue | null {
  const segs = [...value.segs];
  for (const seg of part.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') segs.push(seg);
    else if (segs.length > 0 && segs[segs.length - 1] !== '..') segs.pop();
    else if (value.anchored) return null;
    else segs.push('..');
  }
  return { anchored: value.anchored, segs };
}

/** A path joined onto `base`; an anchored or unknown part gives null. */
function join(base: PathValue, part: PathValue | null): PathValue | null {
  return part && !part.anchored ? push(base, part.segs.join('/')) : null;
}

function joinAll([first, ...rest]: PathValue[]): PathValue | null {
  return rest.reduce<PathValue | null>((acc, part) => acc && join(acc, part), first ?? null);
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: PathToken[], private readonly filePath: string,
    private readonly names: ReadonlyMap<string, string>, private readonly depth: number) {}

  whole(): PathValue | null {
    const value = this.expr();
    return value && this.pos === this.tokens.length ? value : null;
  }

  private eat(punct: string): boolean {
    const token = this.tokens[this.pos];
    if (token?.kind !== 'punct' || token.text !== punct) return false;
    this.pos++;
    return true;
  }

  private expr(): PathValue | null {
    let value = this.term();
    while (value && this.eat('/')) value = join(value, this.term());
    return value;
  }

  private term(): PathValue | null {
    let value = this.primary();
    while (value && this.eat('.')) value = this.attribute(value);
    return value;
  }

  private primary(): PathValue | null {
    const token = this.tokens[this.pos++];
    if (token?.kind === 'name') return this.named(token.text);
    if (token?.kind === 'string') return token.text.startsWith('/') ? null : push({ anchored: false, segs: [] }, token.text);
    if (token?.kind !== 'punct' || token.text !== '(') return null;
    const value = this.expr();
    return value && this.eat(')') ? value : null;
  }

  /** `__file__`, a module name, or a call of a dotted function name. */
  private named(name: string): PathValue | null {
    if (name === '__file__') return { anchored: true, segs: this.filePath.split('/') };
    const assigned = this.names.get(name);
    if (assigned !== undefined) return evaluate(assigned, this.filePath, this.names, this.depth - 1);
    let callee = name;
    while (this.eat('.')) {
      const next = this.tokens[this.pos++];
      if (next?.kind !== 'name') return null;
      callee = next.text;
    }
    return this.eat('(') ? this.call(callee) : null;
  }

  private call(callee: string): PathValue | null {
    const args = this.args();
    const only = args?.length === 1 ? args[0] : undefined;
    if (only && IDENTITY_CALLS.has(callee)) return only;
    if (only && callee === 'dirname') return push(only, '..');
    return args && callee === 'join' ? joinAll(args) : null;
  }

  private attribute(value: PathValue): PathValue | null {
    const token = this.tokens[this.pos++];
    if (token?.kind !== 'name') return null;
    if (token.text === 'parent') return push(value, '..');
    if (token.text === 'parents') return this.parents(value);
    if (IDENTITY_METHODS.has(token.text)) return this.eat('(') && this.args()?.length === 0 ? value : null;
    const args = token.text === 'joinpath' && this.eat('(') ? this.args() : null;
    return args && joinAll([value, ...args]);
  }

  /** `.parents[N]` is the (N+1)-th parent; an N past the path's own parents is null, as Python raises. */
  private parents(value: PathValue): PathValue | null {
    const index = this.eat('[') ? this.tokens[this.pos++] : undefined;
    const n = index?.kind === 'number' && this.eat(']') ? Number(index.text) : Infinity;
    return n < value.segs.length ? { anchored: value.anchored, segs: value.segs.slice(0, -n - 1) } : null;
  }

  /** Positional arguments after an eaten '(' through its ')'; a keyword argument fails to parse. */
  private args(): PathValue[] | null {
    const values: PathValue[] = [];
    while (!this.eat(')')) {
      const value = this.expr();
      if (!value) return null;
      values.push(value);
      if (this.eat(')')) return values;
      if (!this.eat(',')) return null;
    }
    return values;
  }
}
