/**
 * Evaluates statically the Python path expression an importlib loader is given, so the
 * loading module can be linked to the file it loads. Read: string literals, `__file__`,
 * Path()/PurePath()/str()/fspath()/abspath()/realpath()/normpath() (identity), dirname(),
 * join(), `/`, `.parent`, `.parents[N]`, `.resolve()`, `.absolute()`, `.joinpath()`, and
 * the module's single-binding `names`, to a bounded depth so `A = B` / `B = A` ends.
 *
 * `trust` (pythonTrust) says what the expression's file leaves alone: `__file__` gives null
 * unless trusted, a bare call needs its name trusted, and a dotted call needs the prefix
 * os.path, os, posixpath or pathlib with its first word trusted (`x.join` gives null).
 * Anything else is computed at run time and gives null: a guessed path is a false edge.
 * A path anchored on `__file__` comes back root-relative with a leading '/' (null when it
 * climbs above the root); any other is relative as written, normalized, with './'
 * prepended when it has no '/'. An absolute literal gives null.
 */
import type { PathToken } from './python-path-token';
import type { PathTrust } from './python-path-trust';
import { pythonPathTokens } from './python-path-tokens';
import { PathValue } from './python-path-value';

interface Context {
  filePath: string;
  names: ReadonlyMap<string, string>;
  trust: PathTrust;
}

/** Deep enough for ROOT -> SCRIPT -> its use; a cycle runs out of it. */
const MAX_DEPTH = 8;
const IDENTITY_CALLS = new Set(['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'str', 'fspath', 'abspath', 'realpath', 'normpath']);
const IDENTITY_METHODS = new Set(['resolve', 'absolute']);
const MODULES = new Set(['os.path', 'os', 'posixpath', 'pathlib']);

export function pythonPathExpression(expression: string, filePath: string, names: ReadonlyMap<string, string>, trust: PathTrust): string | null {
  const value = evaluate(expression, { filePath, names, trust }, MAX_DEPTH);
  if (!value || value.segs.length === 0) return null;
  const joined = value.segs.join('/');
  if (value.anchored) return `/${joined}`;
  return joined.includes('/') ? joined : `./${joined}`;
}

function evaluate(expression: string, context: Context, depth: number): PathValue | null {
  const tokens = depth > 0 ? pythonPathTokens(expression) : null;
  return tokens && new Parser(tokens, context, depth).whole();
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: PathToken[], private readonly context: Context, private readonly depth: number) {}

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
    while (value && this.eat('/')) value = value.join(this.term());
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
    if (token?.kind === 'string') return token.text.startsWith('/') ? null : new PathValue(false, []).push(token.text);
    if (token?.kind !== 'punct' || token.text !== '(') return null;
    const value = this.expr();
    return value && this.eat(')') ? value : null;
  }

  /** `__file__`, a module name, or a call of a dotted function name. */
  private named(name: string): PathValue | null {
    const { filePath, names, trust } = this.context;
    if (name === '__file__') return trust.file ? new PathValue(true, filePath.split('/')) : null;
    const assigned = names.get(name);
    if (assigned !== undefined) return evaluate(assigned, this.context, this.depth - 1);
    const callee = [name];
    while (this.eat('.')) {
      const next = this.tokens[this.pos++];
      if (next?.kind !== 'name') return null;
      callee.push(next.text);
    }
    return this.eat('(') ? this.call(callee) : null;
  }

  private call(callee: string[]): PathValue | null {
    const args = this.args();
    const name = this.trusted(callee);
    const only = args?.length === 1 ? args[0] : undefined;
    if (only && IDENTITY_CALLS.has(name)) return only;
    if (only && name === 'dirname') return only.push('..');
    return args && name === 'join' ? PathValue.joinAll(args) : null;
  }

  /** The function a dotted callee names when the file's trust covers it; '' when it does not. */
  private trusted(callee: string[]): string {
    const prefix = callee.slice(0, -1).join('.');
    const trusted = (prefix === '' || MODULES.has(prefix)) && this.context.trust.names.has(callee[0] ?? '');
    return trusted ? callee[callee.length - 1] ?? '' : '';
  }

  private attribute(value: PathValue): PathValue | null {
    const token = this.tokens[this.pos++];
    if (token?.kind !== 'name') return null;
    if (token.text === 'parent') return value.push('..');
    if (token.text === 'parents') return this.parents(value);
    if (IDENTITY_METHODS.has(token.text)) return this.eat('(') && this.args()?.length === 0 ? value : null;
    const args = token.text === 'joinpath' && this.eat('(') ? this.args() : null;
    return args && PathValue.joinAll([value, ...args]);
  }

  /** `.parents[N]`; anything but an integer index is null. */
  private parents(value: PathValue): PathValue | null {
    const index = this.eat('[') ? this.tokens[this.pos++] : undefined;
    return index?.kind === 'number' && this.eat(']') ? value.parent(Number(index.text)) : null;
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
