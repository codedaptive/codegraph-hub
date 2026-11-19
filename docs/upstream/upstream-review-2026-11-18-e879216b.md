# Upstream main cc17b69a..e879216b into ours: merge review

Date: 2026-11-18
Owner: Coord-upstream-prs
Request: Orc-Codegraph #4948 (standing job 2, the next daily merge; docs/SPEC-upstream.md §7 item 5), work order upstream-review-e879216b
Companions: `upstream-review-2026-11-18.md` (the cc17b69a review, format precedent), `pr-stack-handover-2026-11-03.md` (custody list)

"Ours" is `integration` at d57e5d7e, which was also `ours` and this worktree's HEAD when this was read. "Theirs" is
upstream main at e879216b. Abbreviations: NM is `src/resolution/name-matcher.ts`, RI is `src/resolution/index.ts`, II
is `src/resolution/import-resolver.ts`, TS is `src/extraction/tree-sitter.ts`, SI is `src/index.ts`, D is
`src/mcp/daemon.ts`, P is `src/mcp/proxy.ts`, MI is `src/mcp/index.ts`. Line numbers in section 3 are lines of the
trial merge's result tree c341a4c9 (below), conflict markers included, unless a line says otherwise ("ours:" means a
line of d57e5d7e).

This lane merged, checked out, built and tested nothing. Every fact below was read with `git log`, `git show`,
`git diff`, `git merge-tree` (in memory only), `rg` or `gh`, in the request's worktree. CodeGraph was not used: the
review reads git trees (the trial merge, upstream's commits) that no index holds.

The merge itself waits for sm.17's promote, so none of this range reaches the sm.17 release (Orc-Codegraph,
2026-11-18 22:38, moot fact "next upstream merge review").

## 1. Range and facts

| Fact | Value | Command |
|---|---|---|
| Ours | d57e5d7ea26a (this worktree's HEAD; `integration` and `ours` were at d57e5d7e when this was read) | `git rev-parse HEAD integration ours` |
| Theirs | e879216bba01; the live `refs/heads/main` was still e879216b after a fetch, so the review covers the whole range | `git fetch upstream`; `git rev-parse upstream/main`; `git ls-remote upstream refs/heads/main` |
| Merge-base | cc17b69a66ad (ours merged it in the cc17b69a merge) | `git merge-base integration upstream/main` |
| Upstream commits past the base | 14 | `git rev-list --count cc17b69a..upstream/main` |
| Ours past the base | 1044 commits | `git rev-list --count cc17b69a..d57e5d7e` |
| Trial merge | tree c341a4c9, 8 conflicting files, all content conflicts | `git merge-tree --write-tree --name-only --messages integration upstream/main` |
| Trial merge onto landing | tree 394b83f1 (landing 141ba492b736), the same 8 files; landing's #3258 take auto-merges with b66de29e in `src/resolution/callback-synthesizer.ts` | `git merge-tree --write-tree --name-only landing upstream/main` |
| Trial merge onto the moved integration | `integration` at 987c3715 (26 commits past d57e5d7e from several lanes: queries, orc, resolution, host, Nagatha, and one Stage 3 doc-fix; none in `src/mcp`, `src/bin` or `__tests__/mcp-daemon.test.ts`): tree ec70ffe2, the same 8 conflicting files | `git diff --stat d57e5d7e integration -- src/mcp src/bin __tests__/mcp-daemon.test.ts` (empty); `git merge-tree --write-tree --name-only integration upstream/main` |

Every conflict is in host's MCP layer; no resolution, queries, fleet or upstream-owned file conflicts.

Conflict blocks per file (`git grep -n -E '^(<<<<<<<|=======$|>>>>>>>)' c341a4c9 -- __tests__/mcp-daemon.test.ts src/mcp`):

| File | Blocks | Lines of c341a4c9 |
|---|---|---|
| `__tests__/mcp-daemon.test.ts` | 1 | 694-791 |
| `src/mcp/daemon-paths.ts` | 1 | 135-150 |
| D | 8 | 70-101, 229-271, 611-641, 663-680, 1162-1168, 1174-1194, 1222-1228, 1233-1240 |
| MI | 2 | 59-77, 192-201 |
| P | 9 | 32-36, 102-165, 171-177, 223-226, 246-250, 255-261, 460-491, 541-547, 791-923 |
| `src/mcp/server-instructions.ts` | 2 | 30-43, 115-173 |
| `src/mcp/session.ts` | 5 | 21-28, 136-191, 321-338, 390-394, 399-424 |
| `src/mcp/tools.ts` | 2 | 3705-3725, 3851-3870 |

## 2. Per-commit table (14 commits, oldest first)

"Files" counts every file the command below lists for the commit, CHANGELOG.md included. "Ours overlap" lists the
files a commit changes (CHANGELOG.md left out) that ours has also changed since cc17b69a
(`git diff --name-only cc17b69a integration`). File level only: an overlap is not a conflict. "PR" is the number in
the commit subject; 6e4fd767's (#3284) is an issue (CLOSED), not a pull request (`gh api graphql`).

| # | Commit | PR | Gist | Files | Ours overlap |
|---|---|---|---|---|---|
| 1 | f2fad8c1 | - | A folder's `package.json` `main` is read for JS/TS only, through a BOM, and followed by sync | 5 | RI, `src/resolution/types.ts` |
| 2 | 6e4fd767 | #3284 (issue) | The prompt hook asks the project's running daemon for its explore (`src/mcp/hook-client.ts`, new) | 7 | `src/bin/codegraph.ts`, `src/mcp/daemon-paths.ts`, MI, `src/mcp/session.ts` |
| 3 | 5a8f6729 | - | A daemon that can't start the explore at once answers busy; the hook runs its own (`prompt-explore.ts`, `QueryPool.tryRun`, `ExecuteOptions.startNow`) | 6 | `src/mcp/query-pool.ts`, `src/mcp/session.ts`, `src/mcp/tools.ts` |
| 4 | 584c03fe | - | The daemon proves it runs as this user before the hook sends a prompt (`src/mcp/daemon-proof.ts`, new) | 7 | D |
| 5 | 101059a4 | - | Changelog entry for the hook's daemon path | 1 | none |
| 6 | ff5e73a5 | #3396 | An MCP session attaches only to a daemon that proves it runs as this user | 10 | `__tests__/daemon-silent-holder.test.ts`, `__tests__/mcp-daemon.test.ts`, D, MI, P |
| 7 | 51747b1b | #3399 | Installer tests use temp folders by their real path (macOS) | 1 | none |
| 8 | b66de29e | #3400 | JS/TS: the functions of a default-exported object are indexed (Vuex store modules), wasm and kernel | 11 | TS, NM |
| 9 | c12cf610 | #3401 | A declaration-only C++ `.h` header is read as C++ (`findCppDeclarationSyntax`) | 3 | `src/extraction/grammars.ts` |
| 10 | 532a3657 | #3402 | `codegraph affected` stops at a process boundary unless `--cross-tier` (fixes issue #3320) | 7 | README.md, `src/bin/codegraph.ts`, `src/db/queries.ts`, SI |
| 11 | c4ecf345 | #3403 | OpenCode clients get the tool names the way OpenCode lists them (`opencode-tool-names.ts`) | 12 | AGENTS.md, `__tests__/upgrade.test.ts`, `src/installer/instructions-template.ts`, P, `src/mcp/server-instructions.ts`, `src/mcp/session.ts` |
| 12 | 8e38e7c3 | - | PHP: an include built from `__DIR__` or `dirname(__FILE__)` links its file | 5 | none |
| 13 | 6dea2fb5 | - | The native kernel links those PHP includes too | 5 | none |
| 14 | e879216b | #3405 | Elysia (Bun) routes, prefixes composed across `.use()` mounts (`frameworks/elysia.ts`, new) | 8 | AGENTS.md, README.md, `src/resolution/frameworks/index.ts` |

Commands: `git log --reverse --name-only --format='== %h %ad %s' --date=short cc17b69a..upstream/main`, compared with
`git diff --name-only cc17b69a integration`. 8e38e7c3 carries an author date (2026-11-17) before the commits around it;
the table follows `git log --reverse` order.

## 3. Per conflict file: what each side changed, and the resolution

Per-file history: `git log --reverse --format='%h %s' cc17b69a..upstream/main -- <file>` (theirs) and
`git log --no-merges --format='%h %s %(trailers:key=Feature,valueonly)' cc17b69a..integration -- <file>` (ours). Many
of ours' commits are landing squashes with no `Feature:` trailer; those are named by subject.

The range has two separate host topics, and the resolutions depend on one decision each:

- **The same-user proof (584c03fe, ff5e73a5 #3396).** The proof's client half auto-merged into ours'
  `connectWithHello` (P 208-221: a challenge in the client hello, then `readProofLine`, then `daemonProofMatches`), and
  MI 702-705 serves in-process on `'unproven'`. Its server half (`answerChallenge`) is inside D's conflict blocks.
  Taking ours in D and keeping the auto-merged P would make ours' machine server prove nothing, so every session would
  get `'unproven'` and be served in-process. The merge must take both halves or neither. **Recommended: take both**
  (resolutions below, marked "proof"). Section 4.2 gives the reason and the alternative.
- **The prompt hook's daemon path (6e4fd767 #3284, 5a8f6729).** It asks a per-project daemon that ours does not have,
  through `getDaemonSocketCandidates(projectRoot)`, which ours removed with `machine-server`. **Recommended: do not take
  it in the merge** (resolutions below, marked "hook"); porting it to the machine server is a host follow-up for a
  ruling (section 4.3).
- **OpenCode tool names (c4ecf345 #3403)** is independent of both: take it in every block it touches.

### 3.1 `src/mcp/daemon.ts` (owner: host)

- Theirs: 584c03fe (`answerChallenge`, `challenge` in `DaemonClientHello`, `parseClientHelloLine` keeps a challenge of
  1-256 characters), ff5e73a5 (the same for every MCP session).
- Ours: the machine server and its session scope: 1f967e06 `machine-server`, cc0e43ef `index-builder`, 5b8ece1a and
  01fed579 `session-focus`, b9d7e144 `cli-builder-route`, 474aca5b `split-server-fix`, and later host landings
  (82d760d3 R-46, 9be4fa03 R-50, the stopped-note series).
- Block 70-101 (imports and constants): **keep ours** and add theirs'
  `import { MAX_CHALLENGE_LENGTH, daemonKey, daemonProof } from './daemon-proof';` (proof). Drop theirs' `writer-lock`
  and `daemon-registry` imports (ours deleted `daemon-registry.ts`; the server takes no writer lock) and
  `DEFAULT_IDLE_TIMEOUT_MS` / `DEFAULT_MAX_IDLE_MS` (ours has no idle exit, R-9, R-10).
- Block 229-271 (`DaemonClientHello`): **keep ours** (`control`, `launchDir`, `focus`, `tools`) and add theirs'
  `challenge?: string` with its doc comment (proof). Drop theirs' `ClientHelloPeers` and its `DaemonStartResult`
  (ours' `DaemonStartResult` with `ServerLockInfo` stands); add `challenge?: string` to ours' `ClientPeers` instead.
- Block 611-641 (the connection handler): **keep ours** (the async repo-anchor flow), destructure
  `({ challenge, ...peers })` and call `this.answerChallenge(socket, challenge)` right after the stopping check and
  before `resolveRepoAnchor` (proof). The client waits for the proof with its hello timeout (P 211); answering first
  keeps the anchor's git lookups out of that wait, and the proof still precedes the session's first byte, since the
  session starts after the anchor resolves.
- Block 663-680: **both**: ours' `dropClient` doc comment, and theirs' `answerChallenge` method above it (proof). It
  signs `this.socketPath`, which in ours is the path the server actually bound (ours: D 414).
- Blocks 1162-1168, 1222-1228, 1233-1240 (signatures of `parseClientHelloLine`, `readClientHello`, `finish`): **keep
  ours** (`ClientPeers`).
- Block 1174-1194 (`parseClientHelloLine` body): **keep ours** and add theirs' challenge check
  (`typeof o.challenge === 'string' && o.challenge.length > 0 && o.challenge.length <= MAX_CHALLENGE_LENGTH`) (proof).

### 3.2 `src/mcp/proxy.ts` (owner: host)

- Theirs: ff5e73a5 (`runProxy` goes through `connectWithHello`; the proof; `readProofLine`), c4ecf345 (OpenCode names
  in the local handshake; `telemetryClient` renamed `clientInfo`).
- Ours: 1f967e06 `machine-server`, cc0e43ef `index-builder`, 5b8ece1a and 01fed579 `session-focus` (launch dir and
  focus in the client hello), b9d7e144 `cli-builder-route`, 474aca5b `split-server-fix`; ours removed `runProxy`,
  `pipeUntilClose` and `startPpidWatchdog`, and serves locally through `dispatchToolCall`.
- Block 32-36 (session import): **both, trimmed**:
  `import { SERVER_INFO, PROTOCOL_VERSION, instructionsForClient, toolsForClient } from './session';`. Ours does not
  use `toolCallArguments` or `TOOL_ARGUMENTS_NOT_OBJECT` (ours' `session.ts` no longer has them), and
  `initializeInstructions` has no use left once block 541-547 is resolved.
- Block 102-165: **keep ours'** `connectWithHello` doc comment and add theirs' sentence on `'unproven'` (proof).
  Drop theirs' `runProxy`.
- Block 171-177 (signature): **both**: ours' parameters (`launchDir?`, `focus?`) and theirs' return type with
  `'unproven'` (proof).
- Block 223-226: **take theirs** (empty): ours' `sendClientHello(socket, launchDir, focus)` after the proof goes. The
  auto-merged call at P 210, `sendClientHello(socket, challenge)`, becomes
  `sendClientHello(socket, launchDir, focus, challenge)`: one client hello carries the anchor, the scope and the
  challenge (proof). The server reads one client hello only, so two would leave the second in the session stream.
- Blocks 246-250 and 255-261 (`sendClientHello`): **combine**: signature
  `(socket, launchDir?, focus?, challenge?)`; the hello keeps ours' `launchDir`, `focus` and `tools` and adds theirs'
  `...(challenge !== undefined ? { challenge } : {})` (proof). Keep ours' doc comment and add that the hello may carry
  the challenge.
- Block 460-491 (in-process tool call): **keep ours** (`dispatchToolCall`), with `telemetryClient` renamed to
  `clientInfo` at line 484: the auto-merge renamed the variable's declaration (P 330).
- Block 541-547 (initialize answer): theirs' `instructionsForClient(SERVER_INSTRUCTIONS, clientInfo?.name)` line, with
  ours' comment on the `routeToDaemon` line.
- Block 791-923: **take only `readProofLine`** from theirs (proof); drop `pipeUntilClose` and `startPpidWatchdog`, which
  ours removed with `runProxy`.
- Auto-merged, keep: the proof check in `connectWithHello` (P 208-221) with the import at P 25 (proof);
  `toolsForClient(getStaticTools(), clientInfo?.name)` in the local `tools/list` (P 549).

### 3.3 `src/mcp/index.ts` (owner: host)

- Theirs: 6e4fd767 (`daemonOptOutSet` moved to `daemon-paths.ts`), ff5e73a5 (`'unproven'`).
- Ours: 92f165e2, 1f967e06 `machine-server`, cc0e43ef `index-builder`, 5b8ece1a and 01fed579 `session-focus`, 474aca5b
  `split-server-fix`, 30fa7483, 82d760d3, 9be4fa03.
- Block 59-77 (imports): **keep ours** (`getServerLogPath`, `getServerSocketCandidates`, `probeServerHello`) and add
  `daemonOptOutSet`: the auto-merge removed ours' local `daemonOptOutSet` (ours: MI 183-188) because theirs moved it,
  and MI 451 still calls it. Drop theirs' `writer-lock` and per-project `daemon-paths` names.
- Block 192-201 (`pollForDaemon`): **both**: ours' comment and theirs' condition with `'unproven'` (proof).
- Auto-merged, keep: `'unproven'` in `pollForDaemon`'s type and doc, and MI 702-705 (serve in-process, spawn nothing)
  (proof).

### 3.4 `src/mcp/daemon-paths.ts` (owner: host)

- Theirs: 6e4fd767, `daemonOptOutSet` exported here. Ours: the machine server's paths (`machine-server`,
  `socket-candidate-length`).
- Block 135-150: **both, trimmed**: ours' `getServerPidPath`, and theirs' `daemonOptOutSet` (MI and, under a later
  hook port, the hook use it). Drop theirs' `getDaemonPidPath(projectRoot)`.

### 3.5 `src/mcp/session.ts` (owner: host)

- Theirs: 6e4fd767 and 5a8f6729 (`PROMPT_EXPLORE_METHOD`, `handlePromptExplore`), c4ecf345 (`instructionsForClient`,
  `toolsForClient`, `TOOL_NAMES`).
- Ours: 8a94fa2b, 6501b2bf, 162d4bad, 47548e7c, 48467fa7, c27aff7b and later host landings: no default project, the
  repo anchor, per-session tool allowlist, the control methods.
- Block 21-28 (imports): **both, trimmed**: ours' line plus
  `import { tools, type ToolDefinition } from './tools';`, `openCodeInstructions` from `./server-instructions`, and
  `import { isOpenCodeClient, withOpenCodeToolNames } from './opencode-tool-names';`. Not `NOT_STARTED` or
  `./prompt-explore` (hook), nor `SERVER_INSTRUCTIONS_NO_ROOT_INDEX` (ours removed it).
- Block 136-191: **keep ours** (empty). Theirs' side is upstream's default-project helpers (`toolCallArguments`,
  `ROOTS_LIST_TIMEOUT_MS`, `fileUriToPath`, `firstRootPath`) and the prompt-explore re-export (hook).
- Block 321-338 (method switch): **keep ours** (`codegraph/releaseProject`, the index-write control methods); drop the
  `PROMPT_EXPLORE_METHOD` case (hook).
- Block 390-394 (initialize instructions): **combine**: `instructionsForClient(SERVER_INSTRUCTIONS, this.clientInfo?.name)`.
- Block 399-424 (`tools/list`): **combine**: ours' comment and allowlist inside theirs' wrapper,
  `toolsForClient(this.engine.getToolHandler().getTools({ allowlist: this.toolAllowlist }), this.clientInfo?.name)`.
  Drop theirs' `await this.retryInitIfNeeded();` (ours has no lazy default project).
- Auto-merged, **remove**: `handlePromptExplore` (lines 455-467; it calls `retryInitIfNeeded`, which ours has not)
  (hook). Keep `TOOL_NAMES`, `instructionsForClient` and `toolsForClient` (lines 97-130).

### 3.6 `src/mcp/server-instructions.ts` (owner: host)

- Theirs: c4ecf345 (`OPENCODE_SERVER_KEY_NOTE`, `openCodeInstructions`). Ours: `machine-server`, `index-builder`,
  `session-focus`, `build-guidance`, R-46 and R-50 texts.
- Block 30-43 (header comment): **both**: ours' focus-paragraph note, then theirs' OpenCode note.
- Block 115-173: **theirs, trimmed**: take `OPENCODE_SERVER_KEY_NOTE` and `openCodeInstructions`; drop
  `SERVER_INSTRUCTIONS_NO_ROOT_INDEX` (ours removed it: one instructions text, no default project). The test that imports it, `__tests__/mcp-opencode-tool-names.test.ts` (taken with c4ecf345; import at line 26 of the trial tree), has a 'no index at the root' case that uses it (lines 129 and 150): that case goes, for the same reason. The import of
  `withOpenCodeToolNames` at line 1 auto-merged.

### 3.7 `src/mcp/tools.ts` (owner: host; the blast text is read by queries)

- Theirs: 5a8f6729 (`ExecuteOptions.startNow`, `NOT_STARTED`, `tryRun` in `execute`). Ours: many host commits; in
  these blocks ours' `execute(toolName, args, sessionState?, options?)` with ours' own `ExecuteOptions`
  (`admitIndexRoot`, line 2358) and the repository-check refusal.
- Blocks 3705-3725 and 3851-3870: **keep ours** (hook).
- Auto-merged, **remove** (all hook, all dead or broken without it): theirs' second `export interface ExecuteOptions`
  and `NOT_STARTED` (lines 1754-1772; two `ExecuteOptions` interfaces would merge as one declaration), and
  `if (opts.startNow) return NOT_STARTED;` at line 3738 (it names `opts`, which ours' signature does not have, so the
  type-check fails while it stays).

### 3.8 `__tests__/mcp-daemon.test.ts` (owner: host)

- Theirs: ff5e73a5, a test that a proxy serves in-process when a stand-in of this version cannot prove itself
  (`proof: wrong` and `none`), on the per-project paths (`getDaemonSocketPath(realRoot)`, `.codegraph/daemon.pid`),
  and upstream's `#692` inactivity-backstop test after it.
- Ours: bfb4a74c and earlier: the in-process fallback answers through the repo anchor.
- Block 694-791: **both**: keep ours' test, and port theirs' stand-in test onto the machine server's paths
  (`getServerSocketPath()`, the state dir's `server.pid` record) (proof). Drop the `#692` backstop test: ours has no
  idle or inactivity exit (R-9, R-10).

### 3.9 Clean merges that change ours' behaviour or break the build

- `src/bin/codegraph.ts` 1896-1909 (hook): the prompt hook now calls `exploreViaDaemon` before its own explore.
  **Restore ours' whole explore block**: from `if (keyworded || tokenVerified) {` (ours 1895) through the end of that `if` (ours' `if (!result.isError && text.trim())` at 1900, its cap and its write), so the trial's `exploreViaDaemon` lines and its `if (text.trim())` go. With the hook topic not taken there
  is no `hook-client.ts` to import. Its stopped note is unchanged either way (it comes from the explore's own answer).
- `CHANGELOG.md`, **not taken** (hook): the trial tree's Unreleased New Features bullet for the prompt hook (#3284, from 6e4fd767 and 101059a4: the hook gets its context from the running server) describes a path that is not merged. Drop that bullet. The Security bullet (#3396, the proof) stays.
- New files of the hook topic, **not taken** (hook): `src/mcp/hook-client.ts` (it imports `getDaemonSocketCandidates`,
  absent from ours' `daemon-paths.ts`, so the type-check fails at its line 22 if it stays), `src/mcp/prompt-explore.ts`,
  `__tests__/prompt-hook-daemon.test.ts`, `__tests__/prompt-hook-daemon-busy.test.ts`; and `QueryPool.tryRun`
  (`src/mcp/query-pool.ts` 836-848), which only the hook path calls.
- New files of the proof topic, **taken and ported** (proof): `src/mcp/daemon-proof.ts` as is;
  `__tests__/fake-daemon.ts` (it imports `getDaemonSocketCandidates`; the ported file takes a socket path, or
  `getServerSocketCandidates()[0]`); `__tests__/daemon-proof.test.ts` (it builds `new Daemon(root, { idleTimeoutMs })`,
  upstream's constructor; ours' `Daemon` takes no arguments, so its server cases are ported and its
  `exploreViaDaemon` cases go with the hook). `__tests__/proxy-connect.test.ts` and
  `__tests__/daemon-silent-holder.test.ts` auto-merged and test the proof client: keep them. Test files are outside the
  type-check (`tsconfig.json` excludes `__tests__`), so a broken import there shows only when vitest runs the file.
- `codegraph affected` (532a3657): with no flag it no longer follows tier edges (`getFileDependents(file, { skipTiers:
  !options.crossTier })`, `src/bin/codegraph.ts` 3266). That changes the test lists `codegraph affected` gives the
  crew once a build with this merge is released and installed. Section 5.

## 4. Host's daemon and prompt-hook paths

### 4.1 How upstream proves the same user

`src/mcp/daemon-proof.ts` (584c03fe, ff5e73a5): the client sends a fresh 32-byte random challenge (base64) in its
client hello; the daemon answers one line `{"codegraph_proof": hmac}` before the session's first byte, where the HMAC
is SHA-256 under a per-user key over `codegraph-daemon-proof-v1`, the challenge and the socket path it listens on. The
key is `~/.codegraph/daemon.key` (`os.homedir()`), 32 bytes, made on first use with mode 0600, in a folder that is created with mode 0700 when it is missing; a key
another user owns or others can read is refused, and one of this user's that others can read is replaced. A daemon
that can get no such key answers `null`. The client reads the key after the proof arrives and compares in constant
time. The hook adds `boundByThisUser` (socket owned by this user, folder owned by this user or root and not writable
by others without the sticky bit); the proxy has the proof only.

### 4.2 Ours against it

| Part of ours | Effect of the proof | Evidence |
|---|---|---|
| Machine server (D) | Must adopt `answerChallenge`, or every proxy session is `'unproven'` and served in-process once the auto-merged client half stays | P 208-221, MI 702-705; 3.1 |
| Server socket | Ours already makes the state-dir socket owner-only (umask 0077 at bind, then chmod 0600; ours: D 259-290), which stops another user from connecting to ours. It does not tell a client that the listener is ours: that is the proof's job | ours: D 259-290 |
| Tmpdir fallback | Ours lists `<os.tmpdir()>/codegraph-server-<hash>.sock` after the state-dir socket (ours: `daemon-paths.ts` 116). On macOS `os.tmpdir()` is a per-user folder; on Linux it is `/tmp`, open to every user. The fork runs on macOS only (S-92), so the exposure here is small; the proof closes it on the systems upstream ships to | ours: `daemon-paths.ts` 81-118 |
| Proxy (P) | Gets the proof in `connectWithHello`; its single client hello must carry `launchDir`, `focus`, `tools` and the challenge together (3.2) | P 208-221 |
| Builder (`src/extensions/host/builder/client.ts`) | Not involved: a forked child over IPC (`fork(entry, ...)`, client.ts 385), no socket | ours: client.ts 363-385 |
| CLI control route (`builder/cli-route.ts`) | Unchanged: its control hello sends no challenge, and the server answers a proof only when asked. It also gets no proof, though it sends index writes; ours' lock record in the state dir names the socket it connects to (cli-route.ts 139). A follow-up for host, not a merge item | ours: cli-route.ts 139, 255 |
| Stop and status probes (`src/mcp/server-control.ts` 103 and 192, `probeServerHello` in `daemon-paths.ts`) | Unchanged: they read the hello only | ours: `src/mcp/server-control.ts` 103, 192 |
| Key location | `~/.codegraph/daemon.key` whatever `CODEGRAPH_STATE_DIR` says, so a development server and the fleet's clients of one user share it. A session whose `HOME` differs from the server's gets `'unproven'` and is served in-process (upstream says the same of "this user's daemon running with another home folder") | `daemonKeyPath()` |
| Socket-path spelling | The HMAC covers the path string. Ours' launcher tries the lock's `socketPath` first (the server's own spelling), then the candidates; a candidate spelled another way (the firmlink case ours' `daemon-paths.ts` 61 and 94-100 describe) fails the proof, and `connectAnyDaemonCandidate` stops at that `'unproven'` answer. That only matters when the lock record is missing | MI 690-697 |
| Tests that start a real server | `daemonKey()` writes `~/.codegraph/daemon.key` under the test's `HOME`. Host confirms its server harness tests set `HOME` to a temp folder, or accepts that a test run creates this user's key | `daemonKeyPath()` |

Why take it: ours' sessions carry tool calls whose answers go into the agent's context, which is exactly what the proof
protects, and the client half is already in ours by auto-merge. Taking it is the smaller divergence from upstream. The
alternative is to drop both halves: remove P 208-221 and the `daemon-proof` import at P 25, drop `'unproven'` from MI
and from `pollForDaemon`, and do not add `daemon-proof.ts`, `fake-daemon.ts`, `daemon-proof.test.ts` or the stand-in
test. That keeps ours' behaviour exactly, and leaves the gap below open.

Security note (rule 12, recorded and raised, it stops nothing): ours' clients do not check that the listener at the
server's socket runs as this user. Severity low on this macOS-only fork (per-user `os.tmpdir()`), higher wherever the
tmpdir fallback is a shared `/tmp` or a Windows pipe name. Location: P `connectWithHello` (ours: P 100-160) and
`builder/cli-route.ts` 139. Owner: host. Fixed by the merge if the proof is taken; otherwise a fix-forward order.

### 4.3 The prompt hook

- Ours' hook (`src/bin/codegraph.ts`, ours: 1866-1898) opens the index read-only itself (`openIndexToRead`) and runs
  explore in its own process; it never talks to the server, and it drops a root in no git worktree (S-88,
  `dropStrayFrontloadRoots`).
- Upstream's 6e4fd767 asks a per-project daemon at `getDaemonSocketCandidates(projectRoot)` with
  `codegraph/promptExplore`, which the daemon's `MCPSession` answers for its one project. Ours has no per-project
  daemon and no such function, and ours' sessions answer only a call that passes the repository check (R-46) with a
  `projectPath`. Taken as is it fails the type-check; typed against ours it would always answer `unavailable`.
- Ported, it would need: the machine server's socket (the lock's `socketPath`, then `getServerSocketCandidates()`),
  a client hello with `launchDir` = the explore root so the session gets an anchor, `projectPath` in the request,
  the session handler going through `dispatchToolCall` with `startNow` added to ours' `ExecuteOptions`, and
  `QueryPool.tryRun`. The gain is upstream's: the server keeps pinned indexes open, so the hook would not reread the
  name lists on each prompt. That is new behaviour for ours, so it is a host order after a ruling, not part of the
  merge (Orc or the designer decides whether to ask).
- 5a8f6729's busy answer and `startNow` exist only for that path, so they go with it.

### 4.4 S-93's valve retry

Not touched: no commit in the range changes `src/db/wal-valve.ts`, `src/sync/` or `src/extensions/host/builder/`
(section 2), so S-93's retry and S-99's scope stand as they are.

## 5. Other lanes' areas

### 5.1 Queries: `affected` and `--cross-tier` (532a3657, #3402)

- `QueryBuilder.getDependentFilePaths(filePath, { skipTiers })` leaves out edges whose metadata carries `tier` (a
  client's HTTP call onto a route, a queue job onto its consumer, an event onto its handler);
  `GraphQueryManager.getFileDependents` and `CodeGraph.getFileDependents` pass the option on; `codegraph affected`
  skips them unless `--cross-tier`. Issue #3320 is CLOSED (`gh`).
- Ours' `codegraph_blast` does not call `getFileDependents`: it walks `incomingEdges` of the kinds it is given
  (`src/extensions/queries/blast/store.ts` 134-144) with no metadata filter, so it still follows tier edges. Not a
  conflict and not changed by the merge. Queries decides whether blast's test counting should leave tier edges out
  as `affected` now does.
- Owners: `src/graph/` is queries'; `src/bin/codegraph.ts` and the `cli-affected-*` tests are host's;
  `src/db/queries.ts` and SI are in no lane's list (orc).

### 5.2 Resolution (all auto-merged)

- f2fad8c1: II, RI and `types.ts`; a folder's `package.json` `main` for JS/TS only, through a BOM, followed by sync.
- b66de29e (#3400): II, NM (7 lines), `callback-synthesizer.ts`, `module-importers.ts`; plus TS and the kernel's
  `tsjs/`. #3258's take (a52e328f, on integration and on landing) also changes `callback-synthesizer.ts`; the trial merges
  onto integration (ec70ffe2) and onto landing (394b83f1) auto-merge it.
- 8e38e7c3: II and `src/extraction/languages/php.ts`; 6dea2fb5: the kernel's `php.rs`.
- e879216b (#3405): new `src/resolution/frameworks/elysia.ts`, plus `express.ts` and `frameworks/index.ts`.

### 5.3 Extraction and kernel (upstream-owned: Orc)

- TS (b66de29e) auto-merged beside ours' patches (fleet README rows `rust-impl-in-fn`, `swift-enum-cases` and others).
- `src/extraction/grammars.ts` (c12cf610): adds `findCppDeclarationSyntax` and one check in `detectLanguage`'s `.h`
  branch. Ours patched the same function for R-49 shebang files (fleet README row `r49-shebang-files`); the hunks do
  not touch and auto-merge (`git diff integration c341a4c9 -- src/extraction/grammars.ts`).
- `codegraph-kernel/src/tsjs/` (b66de29e) and `php.rs` (6dea2fb5): ours changed neither (ours' kernel changes since
  cc17b69a are `rustlang.rs`, `swift.rs`, `langs.rs`, the TypeScript grammar and the build files). The kernel needs a
  rebuild before `kernel-tsjs-parity` and `kernel-php-parity` mean anything.
- `src/installer/` (c4ecf345, 51747b1b): auto-merged beside ours' `installer-block` patch to
  `instructions-template.ts`.

## 6. Coverage: what this range covers

Commands: `gh pr list --repo colbymchenry/codegraph --author @me --state all --json number,title,state,mergeable,headRefOid`,
`gh api graphql` for the R-40 and R-51 PRs and #3284, #3320, #3396, #3402; and for each PR head
`git merge-tree --write-tree --name-only e879216b <head>` (and onto cc17b69a), all heads present locally.

### 6.1 Our features

No feature of ours is covered or made redundant by this range. Related, not covered: ours' owner-only server socket
(474aca5b and the bind under umask 0077) is the server-side half of what #3396 does from the client side (4.2); ours'
`codegraph_blast` against #3402 (5.1).

### 6.2 Our open PRs (the custody list plus #3329)

All 15 are OPEN, none merged or closed; GitHub reports `mergeable` CONFLICTING for all fifteen when read (`gh pr list --repo colbymchenry/codegraph --author @me --state all --json number,state,mergeable`, the same as the cc17b69a
review). The trial merge of each head:

| PR | Name | Onto e879216b | Onto cc17b69a | Range overlap (files) |
|---|---|---|---|---|
| #3197 | node-25-support | clean | clean | `src/bin/codegraph.ts`, AGENTS.md |
| #3198 | sync-mtime-refresh | clean | clean | none |
| #3199 | swift-builtins | clean | clean | NM |
| #3200 | swift-enum-cases | clean | clean | TS |
| #3201 | swift-qualified-inheritance | clean | clean | TS, RI |
| #3202 | rust-impl-in-fn | **CONFLICT** in TS | **CONFLICT** in TS | TS |
| #3203 | rust-path-call-edge-cases | **CONFLICT** in NM | **CONFLICT** in NM | NM |
| #3204 | copied-index-locks | clean | clean | SI, `daemon-paths.ts`, D, MI |
| #3205 | lock-takeover-race | **CONFLICT** in D | **CONFLICT** in D | D |
| #3206 | swift-type-calls | **CONFLICT** in NM | **CONFLICT** in NM | TS, RI, NM, `types.ts` |
| #3207 | suspects | clean | clean | `src/bin/codegraph.ts`, `src/mcp/tools.ts`, NM |
| #3208 | grep-by-symbol | clean | clean | `src/bin/codegraph.ts`, `src/mcp/tools.ts`, NM |
| #3209 | blast-base | clean | clean | `src/bin/codegraph.ts`, `src/mcp/tools.ts`, NM |
| #3210 | orphans | clean | clean | `src/bin/codegraph.ts`, `src/mcp/tools.ts`, NM |
| #3329 | `.codegraphignore` (R-44) | clean | clean | none |

The range adds no new conflict: the four that conflict onto e879216b already conflicted onto cc17b69a, in the same file.
None is covered by the range.

### 6.3 Carried and R-51 PRs

| PR | Upstream state | In ours | Covered by this range? | Head onto e879216b |
|---|---|---|---|---|
| #3249 (R-40) | CLOSED, not merged (its change is upstream's 7f6e4348, in ours since the cc17b69a merge) | yes | n/a | not tried |
| #3256 (dropped from R-51, S-91) | CLOSED, not merged | no (#3365 came with the cc17b69a merge) | n/a | not tried |
| #3261 | OPEN | yes, 3e48e426 (orc r51-3261-rebind-callers) | no | clean; overlap `src/db/queries.ts`, SI (532a3657) |
| #3258 | OPEN | on integration and landing, a52e328f | no | clean; overlap `callback-synthesizer.ts` (b66de29e) |
| #3303 | OPEN | yes, a17ecbbb | no | clean; overlap `grammars.ts` (c12cf610) |
| #3226 | OPEN; head now 8d55142b | yes, e38a37ee | no | clean; overlap `grammars.ts` (c12cf610) |

R-51's rule ("if upstream merges one of them first, it comes with the main merge instead") is not triggered by this
range.

## 7. Owner checks after the merge

Test paths are run with `make zone-test-one DIR=<path>` in the owning lane's tree; upstream's tests live in
`__tests__/` and are run by path.

| Lane | Conflict or item | Check |
|---|---|---|
| host | 3.1-3.4, 3.8 proof | `npx --no-install tsc --noEmit -p .`; `__tests__/mcp-daemon.test.ts`, `__tests__/proxy-connect.test.ts`, `__tests__/daemon-silent-holder.test.ts`, the ported `__tests__/daemon-proof.test.ts`, `__tests__/extensions/host` whole. Behaviour: a proxy session attaches to the machine server (its log names no "could not prove" line) and a stand-in of this version at the socket gets no byte of the session; the CLI control route and `codegraph status`/`stop` still reach the server; `~/.codegraph/daemon.key` is mode 0600; 4.2's `HOME` and spelling rows |
| host | 3.5-3.7 hook not taken, OpenCode taken | the merged tree has no `PROMPT_EXPLORE_METHOD`, `handlePromptExplore`, `NOT_STARTED`, `startNow`, `tryRun` or `exploreViaDaemon` (`git grep`); `__tests__/mcp-opencode-tool-names.test.ts`, `__tests__/installer-targets.test.ts`, `__tests__/upgrade.test.ts`; an OpenCode client's `tools/list` keeps the session's allowlist; decide whether ours' extension tools (blast, orphans, grep, suspects), which are not in `TOOL_NAMES` (`tools.map`), need the OpenCode rename in descriptions |
| host | 3.9 hook restored | the prompt hook's HIGH path runs its own explore again (`src/bin/codegraph.ts`, ours' 1896-1899 restored); its stopped note unchanged |
| host | 4.3 hook port | for a ruling: port #3284's daemon path to the machine server, or leave the hook in-process |
| host | 5.1 CLI affected | `__tests__/cli-affected-cross-tier.test.ts` and the `cli-affected-*` tests; the crew's `codegraph affected` lists skip tier edges once a build with this merge is installed |
| queries | 5.1 | `__tests__/extensions/queries`; whether `codegraph_blast` should leave tier edges out of its test counts as `affected` does |
| resolution | 5.2 | `__tests__/require-directory-package-main.test.ts`, `__tests__/sync-module-config-change.test.ts`, `__tests__/js-default-export-object-members.test.ts`, `__tests__/vuex-dispatch-synthesizer.test.ts`, `__tests__/php-dir-includes.test.ts`, `__tests__/elysia-routes.test.ts`; then `__tests__/extensions/resolution` whole; with landing's #3258, the `callback-synthesizer.ts` auto-merge |
| Orc (upstream-owned) | 5.3 | rebuild the kernel; `__tests__/kernel-tsjs-parity.test.ts`, `__tests__/kernel-php-parity.test.ts`, `__tests__/cpp-declaration-only-headers.test.ts`, `__tests__/extraction.test.ts`, `__tests__/extensions/host/installer-block.gate.test.ts`, orc's `__tests__/extensions/orc/shebang-hookin.integration.test.ts` |
| Orc and Nagatha | new upstream tests | unlisted test files run in the unit group (vitest.config.mts: "unlisted files are unit"); these new ones are not in `test-groups.json` and need a group before landing (S-98): `daemon-proof`, `proxy-connect` (already in ours, unlisted), `cli-affected-cross-tier`, `elysia-routes`, `php-dir-includes`, `cpp-declaration-only-headers`, `js-default-export-object-members`, `mcp-opencode-tool-names` (`kernel-php-parity` is already in ours, changed by 6dea2fb5) |
| fleet | none | no fleet file in the range |
| upstream-prs | 6.2, 6.3 | nothing to push (R-25, rule 12); #3202, #3203, #3205, #3206 still need a rebase before any further push, as before this range |

## 8. Merge recommendation

**Merge with these resolutions**, after sm.17's promote (Orc's call):

1. The proof (584c03fe, ff5e73a5 #3396) taken in both halves, as 3.1-3.4 and 3.8 say; the alternative, both halves
   dropped, is 4.2's last paragraph.
2. The prompt hook's daemon path (6e4fd767 #3284, 5a8f6729) not taken: 3.5, 3.7 and 3.9 say which blocks, auto-merged
   hunks and new files stay out, and `src/bin/codegraph.ts` 1896-1909 goes back to ours.
3. OpenCode tool names (c4ecf345 #3403) taken, combined with ours' allowlist and single instructions text (3.2, 3.5,
   3.6).
4. Everything else auto-merges and is taken as is.

No lane has to land anything before the merge. The 8 conflict files are host's, so the resolutions are host's to
confirm (or to make, if Orc hands the merge's host blocks to host). Pre-merge, Orc or Nagatha files the new upstream
tests into their groups (section 7). Post-merge orders, each for a ruling or the owning lane: host's hook port (4.3),
host's proof on the CLI control route (4.2), queries' tier edges in blast (5.1), and the extension tools' OpenCode
names (section 7).

## 9. What was not read or not done

- No build, type-check or test ran; every "keep", "take" and "remove" above is from reading the trial merge, and the
  merge commit's type-check is the first proof.
- `src/mcp/session.ts`, `tools.ts` and `query-pool.ts` were read only in their conflict blocks and the hunks named; the
  rest of those files' auto-merged hunks, and RI, II, NM, TS, `src/db/queries.ts`, SI and the kernel, were not reviewed
  hunk by hunk.
- Upstream's new tests were read for their imports and the cases named, not run.
- Whether ours' host harness tests set `HOME` (4.2) was not checked.
- docs/SPEC-upstream.md has no §7.5; the order's §7.5 is read as §7 item 5 ("Monthly update").
- CodeGraph was not used (the trees reviewed are not indexed); ours' callers were found with `rg` on the worktree.
