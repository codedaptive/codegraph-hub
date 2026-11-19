# Queries zone guide

The queries zone (`src/extensions/queries/`, tests in `__tests__/extensions/queries/`) holds the
finding and impact tools that sit on top of the index: `grep`, `blast` and `orphans`. `suspects`
belongs to the resolution zone (`src/extensions/resolution/`); grep and blast read its candidate-edge
SQL.

## Focus (`serve --mcp --focus`)

A session started with `serve --mcp --focus <dir>` hands its focus to every extension tool as
`ExtensionToolContext.focus` (absolute canonical directories, `[]` when the session has none).
The queries tools use it as follows (docs/SPEC.md on `ours`, section 4):

| Tool | With a focus |
| --- | --- |
| `codegraph_grep` | Searches inside the focus by default. `scope: "repo"` searches the whole repository. When the focus holds back every hit and the repository has some, a text answer is `No results inside this session's focus (<dirs>). Pass scope: "repo" to search the whole repository.` (success-shaped, never an error); with `json: true` the focused result is returned as is. |
| `codegraph_blast` | Always covers the whole repository. Dependents outside the focus are listed after the in-focus ones under `## Outside focus (N)` (text and markdown, printed only when N > 0); json carries them as `outsideFocus: { dirs, count, modules }`. The headline, impact table and dependent list above the section cover the in-focus dependents only; the test-signal and test-suite sections are not split. `count` is symbols in source modules: dependents in test code (test-only directories, and Rust out-of-line `#[cfg(test)]` module files) stay in `testModules`, unsplit and outside `count`. |
| `codegraph_orphans`, `codegraph_suspects` | Ignore the focus. |

The CLI commands (`codegraph blast`, `codegraph grep`, ...) have no session and no focus; their
output is unchanged by it, and so is an MCP session started without `--focus`. `outsideFocus` is
absent from the report in both cases, so unfocused json is unchanged. A session with a focus that
holds the whole index still carries `outsideFocus` in json, empty (`count: 0`, `modules: []`);
text and markdown print no section.

`codegraph grep`, `codegraph blast` and `codegraph orphans` refuse an indexed root that is in no
git worktree and not opted in with `codegraph init <dir> --no-git`: they print
`requireGitWorktreeRoot`'s refusal on stderr and exit 1. A root with no index keeps each command's
no-index answer (S-84).

Reading the focus: only through host's helpers. `focusPrefixesOfTool` (`src/extensions/queries/shared/focus.ts`) calls host's `focusPrefixesFor` on `ctx.focus`, which host resolves per call against the worktree the call is answered from; a path is tested with host's `inFocus`, which `grep-core.ts` and `blast/focus.ts` import directly. Never compare a path with the raw `ctx.focus` array; `focusDirsText` reads it for display only. The `## Outside focus (N)` heading is `outsideFocusHeading(n)`, byte-equal to host's callers and
impact. Blast's split is `splitReportByFocus` in `src/extensions/queries/blast/focus.ts`.
