/**
 * Session focus, unit level: the helpers in src/extensions/host/server/session-scope.ts, including the
 * per-worktree resolution of the repo-relative focus (real git, a linked worktree and real temp directories),
 * the session fields the proxy's client hello
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
  focusPrefixesForIndex,
  inFocus,
  normaliseFocusArgs,
  parseToolAllowlist,
  resolveFocusForRoot,
  sessionFocusEntries,
  worktreeRootOf,
} from '../../../src/extensions/host/server/session-scope';
import { gitRootByStat } from '../../../src/extensions/host/server/index-root';
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

describe('sessionFocusEntries', () => {
  it('is empty with no list, and with an empty list', () => {
    expect(sessionFocusEntries(undefined)).toEqual([]);
    expect(sessionFocusEntries([])).toEqual([]);
  });

  it('keeps the normalised repo-relative entries, in order, without duplicates', () => {
    expect(sessionFocusEntries(['src/app', './src//lib/', 'src/app'])).toEqual(['src/app', 'src/lib']);
  });

  it('is empty for the whole repository: a "." entry (or "") means no focus', () => {
    expect(sessionFocusEntries(['.'])).toEqual([]);
    expect(sessionFocusEntries([''])).toEqual([]);
  });

  it('is empty when the whole repository is among the entries (it contains every focus dir)', () => {
    expect(sessionFocusEntries(['src/app', '.'])).toEqual([]);
  });

  it('drops wire junk (absolute, escaping, non-string) and keeps the valid entries', () => {
    const junk = ['/etc', 'C:/x', '../escape', 'src/app/../../../x', 42 as unknown as string];
    expect(sessionFocusEntries([...junk, 'src/app'])).toEqual(['src/app']);
  });

  it('has no focus when every entry was junk', () => {
    expect(sessionFocusEntries(['/etc', '../x'])).toEqual([]);
  });

  it('reads at most MAX_FOCUS_ENTRIES entries', () => {
    const dirs = Array.from({ length: MAX_FOCUS_ENTRIES + 10 }, (_, i) => `d${i}`);
    expect(sessionFocusEntries(dirs)).toHaveLength(MAX_FOCUS_ENTRIES);
  });
});

/**
 * One fixture shared by the per-worktree helpers: repository `repo` (a main checkout) with src/app, src/lib and a
 * nested `sub/x`, a linked worktree `sibling` of it, a directory outside git, and symlinks made per test.
 */
describe('the focus resolved against a worktree root', () => {
  let tmp: string;
  let repo: string;
  let sibling: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-session-focus-unit-')));
    repo = path.join(tmp, 'repo');
    for (const dir of ['src/app', 'src/lib', 'sub/x', 'other']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    for (const dir of ['src/app', 'src/lib', 'sub/x', 'other']) fs.writeFileSync(path.join(repo, dir, 'f.ts'), 'export const f = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    sibling = path.join(tmp, 'sibling');
    git(repo, 'worktree', 'add', '-q', '-b', 'sib', sibling);
    sibling = fs.realpathSync(sibling);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('worktreeRootOf', () => {
    it('is the main checkout for the checkout itself and for a directory inside it', () => {
      expect(worktreeRootOf(repo)).toBe(repo);
      expect(worktreeRootOf(path.join(repo, 'src', 'app'))).toBe(repo);
    });

    it('is the linked worktree (a .git file) for a directory inside it, never the main checkout', () => {
      expect(worktreeRootOf(sibling)).toBe(sibling);
      expect(worktreeRootOf(path.join(sibling, 'sub', 'x'))).toBe(sibling);
    });

    // The fixture's tmp root holds `repo` and `sibling` but has no .git itself; the test only means "outside git"
    // when no directory above it has one either (a TMPDIR inside a checkout would), so it skips then.
    it.skipIf(gitRootByStat(os.tmpdir()) !== null)('is the directory itself, canonical, outside git', () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      expect(worktreeRootOf(plain)).toBe(plain);
    });

    it('names the same root for a directory that does not exist yet', () => {
      expect(worktreeRootOf(path.join(repo, 'src', 'not-yet'))).toBe(repo);
    });

    it.runIf(POSIX)('canonicalises a symlinked spelling before looking for .git', () => {
      const alias = path.join(tmp, 'alias');
      fs.symlinkSync(repo, alias, 'dir');
      expect(worktreeRootOf(path.join(alias, 'src', 'app'))).toBe(repo);
    });
  });

  describe('resolveFocusForRoot', () => {
    it('is empty with no entries', () => {
      expect(resolveFocusForRoot(repo, [])).toEqual([]);
    });

    it('resolves an existing entry to its absolute canonical path under the root', () => {
      expect(resolveFocusForRoot(repo, ['src/app'])).toEqual([path.join(repo, 'src', 'app')]);
    });

    it('resolves the same entry against another root: the sibling worktree gets its own directory', () => {
      expect(resolveFocusForRoot(sibling, ['src/app'])).toEqual([path.join(sibling, 'src', 'app')]);
    });

    it('resolves an entry that does not exist yet to its nearest existing ancestor realpath plus the missing tail', () => {
      expect(resolveFocusForRoot(repo, ['src/not-yet'])).toEqual([path.join(repo, 'src', 'not-yet')]);
    });

    it.runIf(POSIX)('resolves a symlinked entry to its real target', () => {
      fs.symlinkSync(path.join(repo, 'src', 'app'), path.join(repo, 'src', 'alias'), 'dir');
      expect(resolveFocusForRoot(repo, ['src/alias'])).toEqual([path.join(repo, 'src', 'app')]);
    });

    it('is empty for a "." entry, and when "." is among the entries', () => {
      expect(resolveFocusForRoot(repo, ['.'])).toEqual([]);
      expect(resolveFocusForRoot(repo, ['src/app', '.'])).toEqual([]);
    });

    it('drops a junk entry and keeps the valid ones, without duplicates', () => {
      const junk = ['/etc', '../escape', 42 as unknown as string];
      expect(resolveFocusForRoot(repo, [...junk, 'src/app', 'src/app'])).toEqual([path.join(repo, 'src', 'app')]);
    });

    // An entry that spells a path inside the root but canonicalises outside it (a symlink to / or to a directory
    // elsewhere) is dropped like wire junk. Kept, `/` would be an ancestor of every index root and focusPrefixesFor
    // would read the whole session as unfiltered.
    it.runIf(POSIX)('drops an entry whose symlink leaves the root, and keeps the entries that stay inside', () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
      fs.symlinkSync(outside, path.join(repo, 'out'), 'dir');
      expect(resolveFocusForRoot(repo, ['up', 'src/app'])).toEqual([path.join(repo, 'src', 'app')]);
      expect(resolveFocusForRoot(repo, ['out', 'src/app'])).toEqual([path.join(repo, 'src', 'app')]);
    });

    it.runIf(POSIX)('has no focus when every entry was dropped for leaving the root', () => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
      fs.symlinkSync(outside, path.join(repo, 'out'), 'dir');
      expect(resolveFocusForRoot(repo, ['out'])).toEqual([]);
      expect(resolveFocusForRoot(repo, ['up', 'out'])).toEqual([]);
    });

    // The containment check is per root: `up` escapes in the main checkout only, so the sibling keeps its entry.
    it.runIf(POSIX)('judges the symlink escape per root', () => {
      fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
      fs.mkdirSync(path.join(sibling, 'up'));
      expect(resolveFocusForRoot(repo, ['up'])).toEqual([]);
      expect(resolveFocusForRoot(sibling, ['up'])).toEqual([path.join(sibling, 'up')]);
    });

    it.runIf(POSIX)('keeps a symlink that points to another directory inside the root', () => {
      fs.symlinkSync(path.join(repo, 'src', 'lib'), path.join(repo, 'src', 'alias2'), 'dir');
      expect(resolveFocusForRoot(repo, ['src/alias2'])).toEqual([path.join(repo, 'src', 'lib')]);
    });
  });

  describe.runIf(POSIX)('focusPrefixesForIndex', () => {
    it('is null (no filtering) with no focus', () => {
      expect(focusPrefixesForIndex(repo, [])).toBeNull();
    });

    it('maps an entry to the index-relative prefix when the index root is the worktree root', () => {
      expect(focusPrefixesForIndex(repo, ['src/app'])).toEqual(['src/app']);
    });

    it('a sibling worktree resolves the focus against its own root: the entry src gives the prefix src there', () => {
      expect(focusPrefixesForIndex(sibling, ['src'])).toEqual(['src']);
      expect(focusPrefixesForIndex(sibling, ['src/app', 'src/lib'])).toEqual(['src/app', 'src/lib']);
    });

    it('is empty (nothing in focus) when no entry lies inside the index', () => {
      fs.mkdirSync(path.join(sibling, 'sub', 'y'), { recursive: true });
      expect(focusPrefixesForIndex(path.join(sibling, 'sub', 'y'), ['src/app'])).toEqual([]);
    });

    it('a nested index root <worktree>/sub maps the entry sub/x to the prefix x', () => {
      expect(focusPrefixesForIndex(path.join(repo, 'sub'), ['sub/x'])).toEqual(['x']);
    });

    it('a nested index root <worktree>/sub finds nothing in focus for the entry other', () => {
      expect(focusPrefixesForIndex(path.join(repo, 'sub'), ['other'])).toEqual([]);
    });

    it('a nested index root inside the sibling worktree reads the entry against the sibling', () => {
      expect(focusPrefixesForIndex(path.join(sibling, 'sub'), ['sub/x'])).toEqual(['x']);
    });

    it('is null (no filtering) when an entry is the index root or contains it', () => {
      expect(focusPrefixesForIndex(path.join(repo, 'sub'), ['sub'])).toBeNull();
      expect(focusPrefixesForIndex(path.join(repo, 'sub', 'x'), ['sub'])).toBeNull();
    });

    it('drops a symlink escape per root: an entry that leaves the worktree does not switch filtering off', () => {
      fs.symlinkSync('/', path.join(repo, 'up'), 'dir');
      expect(focusPrefixesForIndex(repo, ['up', 'src/app'])).toEqual(['src/app']);
      // Every entry dropped: no focus, as with no --focus.
      expect(focusPrefixesForIndex(repo, ['up'])).toBeNull();
    });

    it.skipIf(gitRootByStat(os.tmpdir()) !== null)('outside git, the index root is its own worktree root', () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(path.join(plain, 'src', 'app'), { recursive: true });
      expect(focusPrefixesForIndex(plain, ['src/app'])).toEqual(['src/app']);
      // An entry is read against the index root itself, so a directory that does not exist yet still maps.
      expect(focusPrefixesForIndex(plain, ['not-yet'])).toEqual(['not-yet']);
    });
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
      hasLaunchDir: true,
      control: false,
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

describe('the server instructions on indexing', () => {
  it('tell the agent to mention `codegraph init` to the user, and do not call indexing the user\'s decision', () => {
    expect(SERVER_INSTRUCTIONS).not.toContain("user's decision");
    expect(SERVER_INSTRUCTIONS).toContain('codegraph init');
  });
});
