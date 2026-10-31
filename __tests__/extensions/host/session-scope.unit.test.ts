/**
 * Session focus, unit level: the helpers in src/extensions/host/server/session-scope.ts, the repo anchor
 * they resolve against (real git and real temp directories), the session fields the proxy's client hello
 * carries (src/mcp/daemon.ts), and the wording of `scope` and `--focus` in the tool surface and the server
 * instructions.
 *
 * The gates through the built CLI are in `session-focus.gate.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FocusArgError,
  MAX_FOCUS_ENTRIES,
  SESSION_FOCUS_ARG,
  SESSION_TOOLS_ARG,
  focusPrefixesFor,
  inFocus,
  normaliseFocusArgs,
  parseToolAllowlist,
  resolveSessionFocus,
} from '../../../src/extensions/host/server/session-scope';
import { resolveRepoAnchor, type RepoAnchor } from '../../../src/extensions/host/server/repo-anchor';
import { parseClientHelloLine } from '../../../src/mcp/daemon';
import { getStaticTools } from '../../../src/mcp/tools';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/server-instructions';

/**
 * The focusPrefixesFor vectors below are posix paths ('/r', '/r/sub'). Path
 * resolution is platform-specific (drive letters on Windows), so those blocks are
 * skipped on Windows; every other block runs on every platform.
 */
const POSIX = process.platform !== 'win32';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
}

describe('the internal argument keys', () => {
  it('are the two fixed names the call arguments carry', () => {
    expect(SESSION_FOCUS_ARG).toBe('__cgSessionFocus');
    expect(SESSION_TOOLS_ARG).toBe('__cgSessionTools');
  });
});

describe('normaliseFocusArgs', () => {
  it('turns --focus values into posix paths relative to the repository root', () => {
    expect(normaliseFocusArgs(['src/', './lib//a'])).toEqual(['src', 'lib/a']);
  });

  it('collapses a parent step that stays inside the root', () => {
    expect(normaliseFocusArgs(['a/../b'])).toEqual(['b']);
  });

  it.each(['/abs', '../x', 'a/../../x', '..'])('refuses %s with a FocusArgError that names it', (bad) => {
    let caught: unknown;
    try {
      normaliseFocusArgs([bad]);
    } catch (err) {
      caught = err;
    }
    expect(caught, `${bad} must throw`).toBeInstanceOf(FocusArgError);
    expect((caught as Error).message).toContain(bad);
  });

  it('accepts "." and "" (the whole repository) without throwing', () => {
    expect(() => normaliseFocusArgs(['.'])).not.toThrow();
    expect(() => normaliseFocusArgs([''])).not.toThrow();
  });
});

describe('the focus list cap', () => {
  it('is 64 entries', () => {
    expect(MAX_FOCUS_ENTRIES).toBe(64);
  });

  it('accepts 64 --focus values and refuses 65 with a FocusArgError that names the cap', () => {
    const dirs = (n: number): string[] => Array.from({ length: n }, (_, i) => `d${i}`);
    expect(normaliseFocusArgs(dirs(64))).toHaveLength(64);
    let caught: unknown;
    try {
      normaliseFocusArgs(dirs(65));
    } catch (err) {
      caught = err;
    }
    expect(caught, '65 values must throw').toBeInstanceOf(FocusArgError);
    expect((caught as Error).message).toContain('64');
  });
});

describe('FocusArgError', () => {
  it('is an Error of its own class with the message it was given', () => {
    const err = new FocusArgError('bad value');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FocusArgError);
    expect(err.message).toBe('bad value');
  });
});

describe('resolveSessionFocus', () => {
  let tmp: string;
  let repo: string;
  let anchor: RepoAnchor;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-session-focus-unit-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src', 'app'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'src', 'app', 'app.ts'), 'export const app = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    anchor = await resolveRepoAnchor(repo);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is empty when the session has no anchor', () => {
    expect(resolveSessionFocus(null, ['src/app'])).toEqual([]);
  });

  it('is empty when there are no focus dirs', () => {
    expect(resolveSessionFocus(anchor, undefined)).toEqual([]);
    expect(resolveSessionFocus(anchor, [])).toEqual([]);
  });

  it('resolves an existing focus dir to its absolute canonical path under the anchor root', () => {
    expect(resolveSessionFocus(anchor, ['src/app'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'app'))]);
  });

  it('resolves a focus dir that does not exist yet to its nearest existing ancestor realpath plus the missing tail', () => {
    expect(resolveSessionFocus(anchor, ['src/not-yet'])).toEqual([path.join(anchor.root, 'src', 'not-yet')]);
  });

  it.runIf(POSIX)('resolves a symlinked focus dir to its real target', () => {
    fs.symlinkSync(path.join(repo, 'src', 'app'), path.join(repo, 'src', 'alias'), 'dir');
    expect(resolveSessionFocus(anchor, ['src/alias'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'app'))]);
  });

  it('is empty for the whole repository: a "." entry means no focus', () => {
    expect(resolveSessionFocus(anchor, ['.'])).toEqual([]);
  });

  it('is empty when the whole repository is among the entries (it contains every focus dir)', () => {
    expect(resolveSessionFocus(anchor, ['src/app', '.'])).toEqual([]);
  });

  // An entry that spells a path inside the root but canonicalises outside it (a symlink to / or to a directory
  // elsewhere) is dropped like wire junk. Kept, `/` would be an ancestor of every index root and focusPrefixesFor
  // would read the whole session as unfiltered.
  it.runIf(POSIX)('drops an entry whose symlink leaves the repository, and keeps the entries that stay inside', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
    fs.symlinkSync(outside, path.join(repo, 'out'), 'dir');
    expect(resolveSessionFocus(anchor, ['up', 'src/app'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'app'))]);
    expect(resolveSessionFocus(anchor, ['out', 'src/app'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'app'))]);
  });

  it.runIf(POSIX)('has no focus when every entry was dropped for leaving the repository', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
    fs.symlinkSync(outside, path.join(repo, 'out'), 'dir');
    expect(resolveSessionFocus(anchor, ['out'])).toEqual([]);
    expect(resolveSessionFocus(anchor, ['up', 'out'])).toEqual([]);
  });

  it.runIf(POSIX)('keeps a symlink that points to another directory inside the repository', () => {
    fs.symlinkSync(path.join(repo, 'src', 'lib'), path.join(repo, 'src', 'alias2'), 'dir');
    expect(resolveSessionFocus(anchor, ['src/alias2'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'lib'))]);
  });

  it('drops wire junk (absolute, escaping, non-string) and keeps the valid entries', () => {
    const junk = ['/etc', '../escape', 'src/app/../../../x', 42 as unknown as string];
    expect(resolveSessionFocus(anchor, [...junk, 'src/app'])).toEqual([fs.realpathSync(path.join(repo, 'src', 'app'))]);
  });
});

describe.runIf(POSIX)('focusPrefixesFor (posix vectors)', () => {
  it('turns a focus dir under the index root into an index-relative prefix', () => {
    expect(focusPrefixesFor('/r', ['/r/src'])).toEqual(['src']);
  });

  it('is null (no filtering) when a focus dir is the index root', () => {
    expect(focusPrefixesFor('/r', ['/r'])).toBeNull();
  });

  it('is null (no filtering) when a focus dir is above the index root', () => {
    expect(focusPrefixesFor('/r/sub', ['/r'])).toBeNull();
  });

  it('keeps only the focus dirs inside an index that sits below them', () => {
    expect(focusPrefixesFor('/r/sub', ['/r/sub/a', '/r/other'])).toEqual(['a']);
  });

  it('is empty (nothing in focus) when no focus dir is inside the index', () => {
    expect(focusPrefixesFor('/r/sub', ['/r/other'])).toEqual([]);
  });

  it('is null (no filtering) with no focus', () => {
    expect(focusPrefixesFor('/r', [])).toBeNull();
  });

  it.runIf(POSIX)('compares against the canonical index root, so a symlinked spelling of the root matches', () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-session-focus-root-')));
    const alias = `${real}-alias`;
    try {
      fs.mkdirSync(path.join(real, 'src', 'app'), { recursive: true });
      fs.symlinkSync(real, alias, 'dir');
      expect(focusPrefixesFor(alias, [path.join(real, 'src', 'app')])).toEqual(['src/app']);
    } finally {
      fs.rmSync(alias, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('inFocus', () => {
  it('matches a file under a focus prefix, and the prefix itself', () => {
    expect(inFocus('src/a.ts', ['src'])).toBe(true);
    expect(inFocus('src', ['src'])).toBe(true);
  });

  it('does not match a sibling whose name only starts with the prefix text', () => {
    expect(inFocus('srcx/a.ts', ['src'])).toBe(false);
  });

  it('matches under any one of several prefixes', () => {
    expect(inFocus('lib/x.ts', ['src', 'lib'])).toBe(true);
  });

  it('is true for every file when the prefixes are null (no filtering)', () => {
    expect(inFocus('x', null)).toBe(true);
  });

  it('is false for every file when the prefixes are empty (nothing in focus)', () => {
    expect(inFocus('src/a.ts', [])).toBe(false);
  });
});

describe('parseToolAllowlist', () => {
  it('reads short names, dropping the codegraph_ prefix, blanks and empty entries', () => {
    expect(parseToolAllowlist('explore,codegraph_search, node ,,codegraph_callers')).toEqual(['explore', 'search', 'node', 'callers']);
  });

  it('reads a lone name with or without the prefix', () => {
    expect(parseToolAllowlist('explore')).toEqual(['explore']);
    expect(parseToolAllowlist('codegraph_explore')).toEqual(['explore']);
  });

  it('is null (no allowlist) for an empty or blank value', () => {
    expect(parseToolAllowlist('')).toBeNull();
    expect(parseToolAllowlist('   ')).toBeNull();
  });
});

describe('parseClientHelloLine: the session fields focus and tools', () => {
  const launchDir = path.resolve(os.tmpdir(), 'some project');
  const base = { codegraph_client: 1, pid: 1234, hostPid: 56, launchDir };

  it('keeps focus (an array of strings) and tools (a string) from a well-formed hello', () => {
    const line = JSON.stringify({ ...base, focus: ['src/app', 'lib'], tools: 'explore,search' });
    expect(parseClientHelloLine(line)).toEqual({
      pid: 1234,
      hostPid: 56,
      launchDir,
      focus: ['src/app', 'lib'],
      tools: 'explore,search',
    });
  });

  it('keeps an empty tools string, so a client with no CODEGRAPH_MCP_TOOLS does not inherit the server env', () => {
    expect(parseClientHelloLine(JSON.stringify({ ...base, tools: '' }))?.tools).toBe('');
  });

  it('keeps an empty focus array (a session with no --focus)', () => {
    expect(parseClientHelloLine(JSON.stringify({ ...base, focus: [] }))?.focus).toEqual([]);
  });

  it('keeps a focus of exactly 64 entries and drops one of 65, as the cap says', () => {
    const dirs = (n: number): string[] => Array.from({ length: n }, (_, i) => `d${i}`);
    expect(parseClientHelloLine(JSON.stringify({ ...base, focus: dirs(64) }))?.focus).toHaveLength(64);
    const peers = parseClientHelloLine(JSON.stringify({ ...base, focus: dirs(65), tools: 'explore' })) as Record<string, unknown> | null;
    expect(peers, 'the hello is still a client hello').not.toBeNull();
    expect(peers!.focus, 'focus of 65 entries is dropped').toBeUndefined();
    expect(peers!.tools, 'the rest of the hello is kept').toBe('explore');
  });

  it('leaves focus and tools undefined when the hello does not carry them (the release hello)', () => {
    const peers = parseClientHelloLine(JSON.stringify(base)) as Record<string, unknown> | null;
    expect(peers).not.toBeNull();
    expect(peers!.focus).toBeUndefined();
    expect(peers!.tools).toBeUndefined();
  });

  it.each([
    ['focus', 'a string', 'src/app'],
    ['focus', 'an array holding a non-string', ['src/app', 7]],
    ['focus', 'an object', { 0: 'src/app' }],
    ['tools', 'a number', 3],
    ['tools', 'an array', ['explore']],
  ])('drops %s when it is %s', (key, _shape, value) => {
    const peers = parseClientHelloLine(JSON.stringify({ ...base, [key]: value })) as Record<string, unknown> | null;
    expect(peers, 'the hello is still a client hello').not.toBeNull();
    expect(peers![key], `${key} must be undefined`).toBeUndefined();
  });
});

describe('the tool surface and the instructions describe scope and --focus', () => {
  it('declares a scope argument on codegraph_search and codegraph_explore', () => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,search');
    try {
      const defs = getStaticTools();
      for (const name of ['codegraph_search', 'codegraph_explore']) {
        const def = defs.find((t) => t.name === name);
        expect(def, `${name} is listed`).toBeDefined();
        expect(def!.inputSchema.properties, `${name} declares scope`).toHaveProperty('scope');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names --focus, the scope argument and the Outside focus section in the server instructions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('--focus');
    expect(SERVER_INSTRUCTIONS).toContain('scope');
    expect(SERVER_INSTRUCTIONS).toContain('Outside focus');
  });
});
