/**
 * Worktree PreToolUse hook: spawns the built main.js with a payload on stdin and checks its stdout and exit code.
 *
 * The hook is a Claude Code PreToolUse command. For a call to a codegraph MCP tool (`mcp__codegraph__*`)
 * it answers allow with `projectPath` set to the git root of the call's own cwd, so an agent working in a
 * linked worktree queries that worktree's index and not the main checkout's, and an agent that passed no
 * projectPath, or a wrong one, gets the right root. Every other call gets empty stdout and exit 0: a
 * PreToolUse hook that exits 2 blocks the tool, so the hook never exits 2.
 *
 * The built file is what runs, as the other host tests run dist/. Vitest's global setup rebuilds dist/
 * when src changes. A missing dist/extensions/host/worktree-hook/main.js fails each case at the existence
 * check in runHook, before anything is spawned.
 *
 * The hook is spawned from a decoy git repository, so the root it reports must come from the payload's
 * cwd and never from the hook process's own cwd. A hook that fell back to process.cwd() would answer with
 * the decoy's root and fail every case that expects a root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAIN = path.resolve(__dirname, '../../../../dist/extensions/host/worktree-hook/main.js');

/**
 * Environment for the git calls here and for the hook. A git hook exports GIT_DIR and its siblings; inherited,
 * they would point every git call at that hook's repository instead of the fixtures. The hook itself clears
 * every GIT_* variable except GIT_EXEC_PATH (see the three environment cases below); the other cases strip
 * these four so they stay independent of the caller.
 */
const REPO_REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPO_REDIRECT_VARS) delete env[name];
  return env;
}

/** git with a fixed identity and no signing, so a commit never depends on the developer's config. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/**
 * A git repository at `dir` with one commit that holds `src/deep/sub/leaf.ts`. The subdirectory is committed,
 * so it exists in every checkout of the repository, a linked worktree included.
 */
function makeRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, 'src', 'deep', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'sub', 'leaf.ts'), 'export const leaf = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let parent = '';   // realpath of the temp dir that holds every fixture below
let repo = '';     // the main checkout
let worktree = ''; // a linked worktree of repo
let linkToRepo = ''; // a symlink to repo
let decoy = '';    // a different repository: the hook process's own cwd
let plain = '';    // a directory outside any git repository

beforeAll(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worktree-hook-')));
  repo = makeRepo(path.join(parent, 'repo'));
  worktree = path.join(parent, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', worktree);
  linkToRepo = path.join(parent, 'repo-link');
  fs.symlinkSync(repo, linkToRepo, 'dir');
  decoy = makeRepo(path.join(parent, 'decoy'));
  plain = path.join(parent, 'plain');
  fs.mkdirSync(plain);
  // The premise of the outside-a-repo case: the temp dir is not inside some other repository.
  expect(() => git(plain, 'rev-parse', '--show-toplevel')).toThrow();
});

afterAll(() => {
  if (parent) fs.rmSync(parent, { recursive: true, force: true });
});

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built hook once with `stdin` on its standard input. A string goes in as typed; anything else is
 * JSON-encoded. The process cwd is the decoy repository, so only the payload's cwd can give the right root.
 * `env` is the hook process's environment; it defaults to the caller's with git's redirection variables removed,
 * and a case that tests those variables passes its own.
 */
function runHook(stdin: string | Record<string, unknown>, env: NodeJS.ProcessEnv = childEnv()): HookRun {
  expect(fs.existsSync(MAIN), `built hook missing: ${MAIN}`).toBe(true);
  const res = spawnSync(process.execPath, [MAIN], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd: decoy,
    env,
    timeout: 15_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: `${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`,
  };
}

/**
 * A PreToolUse payload with the fields the hook reads, plus common ones it ignores. It leaves out fields
 * Claude Code also sends, such as `transcript_path` and `permission_mode`. A key whose value is undefined is
 * left out of the JSON, which is how the missing-field cases are built.
 */
function payload(cwd: unknown, toolName: string, toolInput: unknown): Record<string, unknown> {
  return {
    session_id: 'sess-worktree-hook',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_worktree_hook',
  };
}

/**
 * The one answer this hook gives for a codegraph call: allow, with updatedInput replacing the whole tool
 * input. toEqual compares every key, so an extra key or a dropped key fails here.
 */
function expectAllow(res: HookRun, updatedInput: Record<string, unknown>): void {
  expect(res.status, res.stderr).toBe(0);
  // JSON.parse rejects stray text and a second object, so this also asserts "exactly one JSON object".
  expect(JSON.parse(res.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput },
  });
}

/** Every call the hook does not handle: exit 0 and no output at all, so the tool runs unchanged. */
function expectPassThrough(res: HookRun): void {
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toBe('');
}

describe('a codegraph MCP call inside a git checkout gets projectPath pinned to the root', () => {
  it('replaces a wrong projectPath and passes every other input key through', () => {
    const toolInput = { query: 'Foo bar', projectPath: '/wrong/place', limit: 5, nested: { a: [1, 2] }, flag: true };
    const res = runHook(payload(repo, 'mcp__codegraph__codegraph_explore', toolInput));
    expectAllow(res, { ...toolInput, projectPath: fs.realpathSync(repo) });
  });

  it('a cwd in a subdirectory resolves to the repo root', () => {
    const res = runHook(payload(path.join(repo, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf' }));
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(repo) });
  });

  it('a linked worktree resolves to its own root, not the main checkout', () => {
    const res = runHook(payload(path.join(worktree, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf' }));
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(worktree) });
  });

  it('adds projectPath when the agent passed none', () => {
    const res = runHook(payload(repo, 'mcp__codegraph__codegraph_explore', { query: 'Foo bar' }));
    expectAllow(res, { query: 'Foo bar', projectPath: fs.realpathSync(repo) });
  });

  it('a cwd reached through a symlink resolves to the real root', () => {
    const res = runHook(payload(path.join(linkToRepo, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf' }));
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(repo) });
  });

  it('matches every mcp__codegraph__ tool, not only codegraph_explore', () => {
    const res = runHook(payload(repo, 'mcp__codegraph__codegraph_node', { symbol: 'leaf' }));
    expectAllow(res, { symbol: 'leaf', projectPath: fs.realpathSync(repo) });
  });

  // Claude Code started from a git hook, or from a shell that exports GIT_DIR / GIT_WORK_TREE, hands the hook
  // those variables. Git lets them override discovery from the cwd, so an unguarded hook would pin every call
  // to the repository they name. This case passes them explicitly, pointing at the decoy, with a payload cwd
  // inside `repo`: the answer must still be repo's root.
  it('git redirection variables in the hook environment do not override the payload cwd', () => {
    const env: NodeJS.ProcessEnv = {
      ...childEnv(),
      GIT_DIR: path.join(decoy, '.git'),
      GIT_WORK_TREE: decoy,
    };
    const res = runHook(payload(path.join(repo, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf' }), env);
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(repo) });
  });

  // GIT_CEILING_DIRECTORIES stops git's walk up from the cwd at the named directory. With it set to the repo
  // root, `git rev-parse` from a subdirectory finds no repository, and the hook would pass the call through
  // with the agent's own (possibly wrong) projectPath. The hook resolves from the payload cwd alone, so it
  // clears this variable too.
  it('GIT_CEILING_DIRECTORIES naming the repo root does not stop the lookup', () => {
    const env: NodeJS.ProcessEnv = { ...childEnv(), GIT_CEILING_DIRECTORIES: repo };
    const res = runHook(
      payload(path.join(repo, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf', projectPath: '/wrong/place' }),
      env,
    );
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(repo) });
  });

  // GIT_CONFIG_COUNT / KEY_n / VALUE_n inject config entries into every git call. A guard only: it pins
  // the reported root against an injected core.worktree, and passes with or without the hook clearing GIT_*
  // variables, so it does not show that such an injection can move the root.
  it('config injected through GIT_CONFIG_COUNT/KEY_n/VALUE_n does not move the root', () => {
    const env: NodeJS.ProcessEnv = {
      ...childEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: decoy,
    };
    const res = runHook(payload(path.join(repo, 'src', 'deep', 'sub'), 'mcp__codegraph__codegraph_explore', { query: 'Leaf' }), env);
    expectAllow(res, { query: 'Leaf', projectPath: fs.realpathSync(repo) });
  });
});

describe('anything else passes through: empty stdout, exit 0', () => {
  it('a cwd outside any git repository passes through', () => {
    expectPassThrough(runHook(payload(plain, 'mcp__codegraph__codegraph_explore', { query: 'Foo bar' })));
  });

  it('a non-MCP tool (Bash) inside a repository passes through', () => {
    expectPassThrough(runHook(payload(repo, 'Bash', { command: 'ls' })));
  });

  it("another server's codegraph-named tool passes through", () => {
    expectPassThrough(runHook(payload(repo, 'mcp__other__codegraph_explore', { query: 'Foo bar' })));
  });

  it('stdin that is not JSON passes through', () => {
    expectPassThrough(runHook('not json'));
  });

  it('empty stdin passes through', () => {
    expectPassThrough(runHook(''));
  });

  it('a cwd that does not exist passes through', () => {
    expectPassThrough(runHook(payload(path.join(parent, 'no-such-dir'), 'mcp__codegraph__codegraph_explore', { query: 'Foo bar' })));
  });

  // Further cases: cwd missing, not a string, or not an existing directory.
  // The cwd of the regular-file row is resolved inside the test, because beforeAll has not run when this table is built.
  const BAD_CWD: Array<[string, () => unknown]> = [
    ['is missing', () => undefined],
    ['is not a string', () => 42],
    ['is a regular file, not a directory', () => path.join(repo, 'README.md')],
  ];
  it.each(BAD_CWD)('a payload cwd that %s', (_label, cwdOf) => {
    expectPassThrough(runHook(payload(cwdOf(), 'mcp__codegraph__codegraph_explore', { query: 'Foo bar' })));
  });

  // Further cases: tool_input missing or not an object.
  const BAD_TOOL_INPUT: Array<[string, unknown]> = [
    ['is missing', undefined],
    ['is null', null],
    ['is an array', [1, 2]],
    ['is a string', 'query'],
  ];
  it.each(BAD_TOOL_INPUT)('an mcp__codegraph__ call whose tool_input %s', (_label, toolInput) => {
    expectPassThrough(runHook(payload(repo, 'mcp__codegraph__codegraph_explore', toolInput)));
  });
});
