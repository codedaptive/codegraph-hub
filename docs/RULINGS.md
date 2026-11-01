# Rulings register

Bob's rulings, numbered R-1, R-2, ... and never renumbered. Recorded by Designer-Codegraph and posted to
General as a RULING line. Decisions already settled by a document live in `team/settled.md` (S-n).

## R-1. Go-ahead for the global install of 1.6.2-sm.2
- Date: 2026-10-29 22:20 / Bob
- Ruling: install the packed 1.6.2-sm.2 tarball (`releases/`, ours 11b39cfc) globally, replacing sm.1 at /opt/homebrew/bin/codegraph.
- Work implied: Orc-Codegraph installs it and confirms the version and the 10 MCP tools from the installed binary.

## R-2. Telemetry off
- Date: 2026-10-29 22:20 / Bob
- Ruling: turn CodeGraph telemetry off for the global install (`codegraph telemetry off`), in addition to `DO_NOT_TRACK=1`.
- Work implied: Orc-Codegraph runs it after R-1 and confirms the setting.

## R-3. Go-ahead: install sm.3 and run go-live now
- Date: 2026-10-30 02:25 / Bob ("OMG GO!")
- Ruling: install 1.6.2-sm.3 globally, then run `fleet/rollout/go-live-runbook.md` end to end now.
- Work implied: Orc-Codegraph runs both and reports when every team has a working code-graph tool; a failed step is
  rolled back per `fleet/rollout/rollback.md` and reported.

## R-4. Deadline: a working, finished CodeGraph at 09:00 CDT 2026-10-30
- Date: 2026-10-30 02:20 / Bob (going offline until morning)
- Ruling: the team works MISSION.md and its specs overnight so that at 09:00 CDT CodeGraph is live on every team and
  the mission's work packages are finished. Bob is unavailable until then: settle what the documents and rulings
  settle; anything that truly needs Bob goes into team/questions.md for 09:00 and work continues around it.
- Work implied: Orc-Codegraph plans to 09:00 (go-live under R-3 first, then the open work packages) and has a
  status at 09:00 naming what is done, what is not, and why.

## R-5. Q-8: fulcrum excludes .codegraph/ locally
- Date: 2026-10-30 / Bob
- Ruling: add `.codegraph/` to fulcrum's `.git/info/exclude` (local, uncommitted), as the other team repositories have.
- Work implied: Orc-Codegraph adds the line and confirms with git check-ignore.
- Done: 2026-10-30, Orc-Codegraph (#1029); git check-ignore on fulcrum exchange names the exclude line.

## R-6. Q-9: install sm.4 and sm.5 when each passes its gate
- Date: 2026-10-30 / Bob
- Ruling: install 1.6.2-sm.4, and sm.5 when WP1 lands, globally once each passes the release gate and the tarball check, by the R-1/R-3 procedure (telemetry off confirmed; rollback to the previous sm.N on a failed check).
- Work implied: Orc-Codegraph installs each and reports the version and checks.
- sm.4 done: 2026-10-30, Orc-Codegraph (#1033); global install reports 1.6.2-sm.4 (ours cc50cfa9), telemetry off, all 10 tools list and all 7 teams answered their probe. sm.5 done: 2026-10-31, Orc-Codegraph (#1448); ours 687fb5a6, global install reports 1.6.2-sm.5, telemetry off, the ten tools list, all seven teams answered a codegraph_search through one machine server (state dir ~/.codegraph).

## R-7. Q-10: clear the graft leftovers
- Date: 2026-10-30 / Bob
- Ruling: yes. (1)-(3) in the agent catalog with one regeneration: regenerate aimodel, bench, forge and fulcrum from the current catalog, rewrite the blast-radius and orchestrator skills on CodeGraph, drop the graft hook entries and `mcp__graft__|` from the teams' settings.json. (4) the one-line edit to fleet's job line in codeteam/teams/codegraph.toml and codeteam's two claude-fab smoke fixtures.
- Work implied: Orc-Codegraph routes it (fleet zone) and reports when no team carries a graft reference.

## R-8. Trusted-local MCP: query scope selects a database, not an access boundary
- Date: 2026-10-30 / Bob, direct ruling relayed by Orc-Codegraph (#1103; host instruction #1102, settled S-40).
- Ruling: this MCP serves a trusted private developer box. Agent-supplied query scope selects the code-graph
  database to answer from; any checked-out repository may be queried. MCP needs no repository/edition
  access-control or security machinery for this use.
- Supersedes: MISSION.md WP1's per-session repository allowlist and CE/EE read barrier, the corresponding
  requirements and cross-repository refusal acceptance in Orc-Codegraph's `host-wp1-wp2.md`, and S-38's live-open
  file-swap security gate and safe-open/native-API blocker. The pending WP1 security design review is cancelled;
  no hostile-filesystem gate, native-binding redesign or additional security investigation is required for WP1.
- Work implied: continue the existing `multi-project-host` feature for correct requested-database answers,
  lifecycle/freshness and measured performance; remove the superseded repository-authorization requirements and
  machinery rather than retaining a parallel path. Scope supplied by agents remains database selection, not
  authorization; a normal query must not accidentally answer from a cached/default sibling. Ordinary SQLite/data
  integrity, copy safety, writer coordination and unrelated path/argument validation remain intact.
- Acceptance retained: per-repository hosts, off-main-thread sync/indexing, development/fleet separation, bounded
  orderly stop and the existing performance measurements remain required. The 40-worktree/10-client query p95
  must be under 500 ms; the required 5 GB foreign cold-build interference check is not waived; memory is reported
  against the baseline, with under 8 GB a stretch only. R-6's sm.5 release and tarball gates remain unchanged.

## R-9. Intended MCP design: one system-wide server and five-minute database idle close
- Date: 2026-10-30 / Bob, direct design clarification while asking how it compares with the work in progress.
- Clarified design: one system-wide CodeGraph MCP server serves queries for every repository/worktree. Each
  query supplies the repository/worktree path identifying its local database. If no database exists there, the
  server creates and initializes it; otherwise it opens the existing database and answers the query. After no
  queries for that worktree/database for five minutes, the server closes that database, leaving it on disk for
  the next query. No permanently open pinned-database exception was included in this design.
- Confirmation and rationale: Bob explicitly rejected the per-repository/database server topology: multiple
  persistent servers are what this design was intended to avoid, because CodeGraph queries are infrequent and
  do not justify that overhead. One MCP configuration entry backed by several repository servers does not meet
  the design.
- Supersedes: MISSION.md WP1's one-host-per-repository topology, WP2's pinned-open exception, and R-8's retained
  per-repository-host clause. The inspected WP1 branch's ten-minute idle default/pinned exemptions and its
  registration/opt-in gate on no-sibling initialization must be aligned to the clarified lifecycle above.
  R-8's trusted-local query-scope ruling remains applicable.
- Work implied: Orc-Codegraph stops advancing the per-repository topology, aligns the governing requirements
  and revises the existing WP1 work order to the single system-wide host and five-minute database lifecycle,
  preserving reusable implementation work. Handed to Orc-Codegraph as REQUEST #1134. This is not WP1
  acceptance, a performance-gate waiver or authorization to change the live install/shared MCP wiring before
  acceptance.

## R-10. Private tool, one server per computer, no ceremony
- Date: 2026-10-30 / Bob, direct.
- Ruling: (a) this is a standalone improvement of CodeGraph for Bob's private use: not public, never distributed. It has nothing to do with CE/EE editions or with moot; any requirement derived from them is void. (b) One MCP server per COMPUTER; it serves the CodeGraph interface for any directory on the machine, the query path selecting that directory's database (R-9 lifecycle: create if absent, open on demand, close after five query-idle minutes). (c) The work is writing the code and delivering it. Agents do not stop for missing scaffolding files: they create what is missing and continue. Waiting is allowed only while a compile or test is running.
- Deadline: WP1 delivered by about 18:15 CDT 2026-10-30.
- Supersedes: every CE/EE/edition/moot reference in WP1's requirements.

## R-11. The CodeGraph server spec (Bob's new mission)
- Date: 2026-10-30 / Bob, written decision: `/Users/bob/devlop/team-codegraph/SPEC-codegraph-server-2026-10-30.md`
  (#1222). Expanded into `docs/SPEC.md`.
- Ruling: one server per computer; databases opened on demand and closed after 10 idle minutes, no open limit; an
  index covers its worktree's whole repo; the session's launch directory anchors its repo and a call outside it is
  rejected; `--focus <dir>` narrows finding tools by default, impact tools stay whole-repo and list out-of-focus
  results separately; every call needs `projectPath` ("missing argument: root path to the code you wish to query");
  an optional shipped PreToolUse hook sets `projectPath` to the git root of the agent's cwd and always wins when
  deployed; no access control beyond the anchor; one long-lived builder process with a queue does every index
  write, small syncs ahead of cold builds; a worktree with no index copies one from the nearest-commit indexed
  sibling (the lifecycle on `ours`, cleanup and pins included); standing worktrees are pinned, always open and
  current; nothing codeteam-specific (codeteam supplies `--focus` from `CODETEAM_ZONE` and deploys the hook).
- Supersedes: R-9's five-minute close and its no-pin rule (pinned standing worktrees stay open); R-8's "any
  checked-out repository may be queried" (now only the anchor repo); MISSION.md WP1's `CODEGRAPH_MAX_PROJECTS`
  and in-server worker processes (replaced by the builder process); S-42 where it conflicts. R-8's no-security
  stance and R-10 (private, one server per computer, no ceremony) stand.
- Work implied: Orc-Codegraph re-plans WP1 on `lane/host` against `docs/SPEC.md`.

## R-12. Bob's answers to SPEC draft 2 and the legacy questions
- Date: 2026-10-30 / Bob (#1227)
- Ruling: the server spec (R-11) replaces MISSION.md; nothing only in MISSION.md applies. Q-11: graft has nothing
  to do with building the tool; stop working on it. Q-12: write the two missing worker-context files
  (`PROJECT.md`, `rules/toolchain-typescript.md`) and continue. Performance targets are out of the spec.
  Development builds are built in an isolated directory and run on their own test socket/port, never the live
  server. The upstream process (daily merge, squashes, nightly check, upstream issue) waits until the tool is
  finished. SPEC readings: 1 = the first client starts the server, the server starts the builder, neither exits
  when idle; 3 = no sibling means a full build from the queue, no opt-in; 2, 4-8 approved as written.
- Supersedes: R-7 (graft leftovers) as work for this team; S-33's opt-in gate; S-43's publication hold; the
  performance acceptance carried from MISSION.md/R-8.
- Work implied: Orc-Codegraph writes the two Q-12 files and plans against docs/SPEC.md draft 3.

## R-13. The harness is not ours
- Date: 2026-10-30 / Bob (#1243), standing rule.
- Ruling: the team's work is the CodeGraph code in the fork, to the server spec (R-11, docs/SPEC.md). codeteam, the
  agent catalog, role files and templates, other teams and graft are the harness: do not change them, propose
  changes or ask about them. A wrong or missing harness file is one line in a status, and work continues; only a
  true blocker of product work goes to Orc-Codegraph in one line, and Bob fixes it. Bob updated the codegraph
  product guide himself (points at the spec, no Node ceiling); bilby.md stays as it is.
- Supersedes: any harness work implied by earlier rulings (R-7, S-43 publication, the catalog half of R-12's Q-12).
- Work implied: Orc-Codegraph passes the rule to every lane.
- Restated 2026-10-30 (#1252) for the whole team, wider: the harness also includes the team's `.claude` settings,
  rules and hooks, and Claude Code's and herdr's settings. A hook now refuses writes to it. The product-guide and
  bilby.md questions are closed.

## R-14. Q-13: CLI index writes go through the builder when it is running
- Date: 2026-10-31 / Bob, direct.
- Ruling: the CLI commands that write an index (`codegraph init`, `index`, `sync`, `checkpoint`/`--fresh`) hand the
  work to the builder when it is running; when it is not, they write the index in their own process (under the
  writer lock), so the CLI stays the repair path.
- Refines: [B9] (R-11); answers Kong's K-43 (#1307).
- Work implied: Orc-Codegraph routes the CLI write commands to a running builder (host lane).

## R-15. Q-14: uninit releases through a running server; unlock refuses a live holder
- Date: 2026-10-31 / Bob ("agreed", to the recommendation).
- Ruling: `codegraph uninit`, with a server running, asks it to release the root first (the builder's release op),
  then deletes `.codegraph/`; with none running it deletes as today. `codegraph unlock` stays the repair tool for a
  lock whose owner is dead; when a live process holds the lock it says so and removes nothing.
- Refines: R-14; answers Kong's K-45 (#1516).
- Work implied: Orc-Codegraph routes both changes (host lane).
- Confirmed 2026-10-31 (Bob): `uninit` being undone by the next query (R-12, no opt-in) is the intended behaviour.

## R-16. Q-15: builder robustness items closed as non-issues
- Date: 2026-10-31 / Bob, direct.
- Ruling: the builder liveness watchdog, a git hook's `sync -q` waiting behind a running job, and a stale
  `rebuild.pid` after a killed builder are closed as non-issues; they are dealt with only if one ever surfaces.
- Basis: no hang seen in the builder log; no CodeGraph git hooks are installed in the machine's repositories; a stale
  `rebuild.pid` is reclaimed.
- Work implied: none. Answers Orc #1657 (host's cli-builder-route report, Open 1, 3, 4).
