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
- Note 2026-11-01: the code also has an opt-out, `CODEGRAPH_NO_AUTO_SEED=1`, which turns automatic seeding and cold
  builds off for the process that sets it (docs/SPEC.md §3). It is consistent with "no opt-in"; nothing sets it.

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

## R-17. Offer our work upstream: PRs, a public fork and one issue
- Date: 2026-10-31 / Bob, direct.
- Ruling: open pull requests upstream for the changes that make sense on their own; publish a public fork with
  everything else and open one upstream issue describing what the fork adds, offered for upstream to use as it
  likes; if upstream wants any of it in the main repository, we volunteer to bring it over.
- Supersedes: R-10(a)'s "never distributed" (the fork is published) and R-12's deferral of the upstream process.
- Expanded in `docs/SPEC-upstream.md`. Work implied: Orc-Codegraph plans it; Bob publishes.
- Amended 2026-10-31 (Bob): the team does the work with `gh`, creating the fork under `codedaptive` and opening the
  PRs and issues itself. `grep`, `blast`, `orphans` and `suspects` are PRs, not fork-only: their logic needs no
  extension hooks. Readings 1-2 of SPEC-upstream draft 1 stand.
  Fork name (Bob): `codedaptive/codegraph-sharedserver`, public.

## R-18. Go on the R-17 plan: upstream refresh first; sm.8 stays installed
- Date: 2026-10-31 / Bob, direct.
- Ruling: follow Orc-Codegraph's R-17 plan (`design/Orc-Codegraph/ledger/reports/r17-plan.md`), bringing our code up
  to current upstream first. The installed 1.6.2-sm.8 stays in use: all testing runs in isolation (development
  builds on their own socket and state directory, throwaway clones), and Bob is told before any local install or
  update replaces it.
- Work implied: Orc-Codegraph starts the plan; any new `sm.N` install waits for Bob's go-ahead.

## R-19. Publishing the R-17 offer
- Date: 2026-11-01 / Bob, direct (answers Orc #1716).
- Ruling: (1) open all 14 PRs in one wave; (2) remove every reference to "graft" from what is published (fork and
  PRs); (3) public commits carry `bob-codedaptive.com <bob@codedaptive.com>`; (4) promote the upstream merge to
  `ours` as sm.9, without installing it (R-18 still holds: ask Bob before any install).
- Work implied: Orc-Codegraph publishes per `design/Orc-Codegraph/ledger/reports/r17-publish-plan.md` once Kong's
  read and the per-branch suites are clean.

## R-20. Overnight mode, 2026-11-01
- Date: 2026-11-01 / Bob, direct.
- Ruling: overnight mode. The team fires back up and works its backlogs through the night without waiting on Bob:
  settle what the documents and rulings settle; anything that truly needs Bob goes into team/questions.md and work
  continues around it. Sessions now run on a new model with slightly different guard rails, and navigate with the
  installed CodeGraph (1.6.2-sm.8), which does the code-index work graft used to do.
- Still binding: R-13 (the harness is not ours), R-18 (sm.8 stays installed; test in isolation; ask Bob before any
  install or update), R-19 (the R-17 publishing answers).
- Work implied: Orc-Codegraph restarts every lane on its backlog and finishes R-17's publication; a status for Bob
  in the morning naming what was done, what was not, and why.

## R-21. No Linux/Windows validation before the upstream PRs
- Date: 2026-11-01 / Bob, direct ("this can not be done").
- Ruling: the lock PRs (and every R-17 PR) go upstream without Linux or Windows validation. Each PR text says it was
  tested on macOS only, so the maintainer can validate the other platforms.
- Supersedes: Orc-Codegraph's todo item to validate the lock PRs on Windows and Linux before opening them.
- Work implied: Orc-Codegraph drops that step and checks the PR texts say macOS only.

## R-22. Publish the R-17 set now; no duplicate test runs
- Date: 2026-11-01 / Bob, direct.
- Ruling: upstream moves fast, so a duplicate test run makes the PRs stale. Kong's clear read (09:20) is the gate:
  stop the per-branch full suites and publish now: the fork, all 14 PRs and the three issues. Upstream's CI runs
  the suite on each PR; a failure there is fixed on that PR.
- Supersedes: the per-branch full-suite step in the R-17 publish plan.

## R-23. Lift the stop for codegraph work; finish the PR review fixes and replies
- Date: 2026-11-02 / Bob, direct.
- Question: the team is stopped (Designer #1834) with the Codex review triage of the R-17 PRs half done (24 of 29
  comments triaged and fixed locally, #3209 unverified, #3210 not started, nothing pushed or replied). Resume?
- Ruling: yes. The team may work on codegraph again. Finish every review fix not yet pushed to its PR, push them,
  and answer each Codex comment on its thread: what was fixed where it was right, the reason where it was wrong.
  Test versions (development builds on their own socket and state directory, throwaway clones) are fine; the
  installed CodeGraph on this machine is not replaced without asking Bob, because other teams use it.
- Reason: the PRs have sat a day with 29 unanswered findings; the installed version serves every team.
- Not chosen: keeping the full stop; a follow-up "review fixes" commit per PR instead of the planned squash and
  force-push (Bob did not ask for it; the one-squash-per-feature rule in rules/product.md stands).
- Still binding: R-18 (ask before any install), R-21 (macOS only), R-22 (only the changed tests run).
- Work implied: Orc-Codegraph resumes r17-review-triage.md from its "STILL TO DO" list: #3209 verify, #3210's three
  comments, restack, push the changed pr/* branches, edit the PR bodies, post all 29 replies, back up; reports the
  per-PR result.

## R-24. Codex bot review: one more round, then stop (answers Q-16)
- Date: 2026-11-03 / Bob, direct.
- Question: the Codex bot re-reviews every push (18 new comments on eight PRs after R-23, more likely on #3209 and
  #3210); how far do we chase it?
- Ruling: one more round, then stop. Triage every bot comment posted since the R-23 pushes (the 18, plus any on
  #3209 and #3210), fix the real ones with tests that fail first, push once per PR, and reply on each thread: what
  was fixed, or why it is wrong. After that round the team stops working the bot's comments: no further fixes or
  replies for comments drawn by the round-two pushes.
- Reason: the new comments land on our own fixes and may be real; the bot never goes quiet, so the cost needs a cap.
- Not chosen: (a) stop now with the 18 unanswered; (c) chase until the bot is quiet; Orc's variant of answering
  later comments with replies only (Bob said stop).
- Still binding: R-18 (installed CodeGraph untouched), R-21 (macOS only), R-22 (only changed tests run).
- Work implied: Orc-Codegraph runs round two and reports per-PR results; then the PR work waits on the maintainer.

## R-25. No nudging the maintainer; replies go out as they are ready
- Date: 2026-11-03 / Bob, direct.
- Question: (1) comment on #3211 asking the maintainer to approve CI runs on our PRs? (2) post bot replies in a
  daily batch?
- Ruling: (1) no: it is their repo, so we do not press the maintainer; CI waits for him. (2) each reply is posted
  when it is ready, not batched.
- Reason: upstream sets the pace; a reply ready now serves the reader now.
- Not chosen: a CI-approval comment; a daily reply batch.
- Work implied: Orc-Codegraph posts no comment asking the maintainer for anything and posts R-24's round-two
  replies as each is ready.

## R-26. A new lane, upstream-prs, owns our upstream pull requests
- Date: 2026-11-03 13:27 / Bob, posted by codeteam to Orc-Codegraph and Designer-Codegraph.
- Question: who runs the upstream PR work and the analysis of new upstream commits, now that the PRs need a
  standing owner?
- Ruling: a new lane, upstream-prs (Coord-upstream-prs), owns our upstream pull requests and the analysis of new
  upstream commits. It cuts pr/<feature> branches, cherry-picks and restacks with tree and patch-id proofs, pushes,
  and keeps PR bodies and replies current. A code change inside a PR goes as a REQUEST to the lane that owns that
  code (host, queries, resolution), and that lane stacks the commit. It reviews new upstream commits and reports to
  Orc-Codegraph what to pull down and what conflicts; the daily merge through integration stays Orc-Codegraph's.
  Its home is workcrews/upstream-prs/ (the _base checkout, the rs3 worktree, BRIEF-*.md, texts/).
- Hand-over: Orc-Codegraph finishes RS-3 itself (pre-push checks, the three pushes for #3208, #3209 and #3210, the
  six replies), then hands the PR stack to Coord-upstream-prs in one REQUEST (open PRs, branches and heads,
  r17-round2-results.md, notes). From then on Orc-Codegraph routes PR work and runs no leads for it.
- Still binding: R-24 (after round two, no fixes or replies for what its pushes draw), R-25, R-21, R-22, R-18.
- Work implied: as above; the lane's first job is the hand-over, then upstream analysis.

## R-27. Overnight mode, 2026-11-04
- Date: 2026-11-04 00:3x / Bob, direct ("keep the project moving forward overnight").
- Question: Bob is offline overnight with the carry-back and the S-47/S-50 PR pushes under way; does the team wait
  for him or keep working?
- Ruling: keep working through the night without waiting on Bob, as under R-20: settle what the documents and
  rulings settle; anything that truly needs Bob goes into team/questions.md and work continues around it.
- Reason: the open work needs no new decision from Bob; it is already ruled (R-24, R-26, S-47 to S-51).
- Not chosen: pausing the lanes until morning.
- Still binding: R-13 (the harness is not ours), R-18 (sm.8 stays installed; no install or update without Bob),
  R-21 (macOS only), R-22 (only changed tests; one whole-suite gate), R-24 (no bot-comment work), R-25 (nothing asks
  the maintainer for anything). Spec text changes wait for Bob (Q-17).
- Work implied: Orc-Codegraph keeps every lane on its backlog: finish the carry-back (queries' grep and orphans
  fixes with O-01 to O-11; resolution's qualified-supertype feature on exchange and its remaining Swift and Rust
  rows), run the whole-suite gate once on the merged integration and promote to `ours` if it passes, with no
  install; upstream-prs makes the S-47/S-50 final pushes (#3199 with its children restacked, #3209, #3210). A
  status for Bob in the morning naming what was done, what was not, and why.

## R-28. Spec text that only catches up with settled behaviour is the designer's (answers Q-17)
- Date: 2026-11-04 / Bob, direct ("Kong's finding is not a decision worthy of my time; you should be able to figure
  it out").
- Question: Q-17: two docs/SPEC.md §6 rows lag the carried-back PR review fixes: blast seeds per changed line from
  the merge base to the working tree (S-51), and grep leaves a stale file's hits unattributed (R2-05, Kong K-F5).
  Does each such text change need Bob?
- Ruling: no. Where a SPEC line only describes behaviour already settled (a ruling or a settled.md entry, or a
  carry-back row Kong has cleared), Designer-Codegraph rewrites the line to match and records it; Bob is not asked.
  A change to what the product does still goes to Bob.
- Reason: the decision was made where the behaviour was settled; the text is bookkeeping.
- Not chosen: holding each text catch-up in team/questions.md for Bob.
- Done: both §6 rows rewritten in the same commit; Q-17 closed.

## R-29. Deadline: the project complete by noon, Wednesday 2026-11-04
- Date: 2026-11-04 02:00 CST / Bob, direct ("Please complete this project by noon CDT Wed November 4th").
- Question: when does the round S-52 closed have to be finished?
- Ruling: by noon on 2026-11-04. Daylight time ended on 1 November, so noon CDT as written is 11:00 on the
  machine's CST clock; the team works to 11:00 CST so either reading is met.
- Complete means: S-52's list integrated, the whole-suite gate run once and green, promoted to `ours` as the next
  sm.N and packed to `releases/`, SPEC §8 current, and the S-52 PR pushes made with their bodies current. Installing
  the new build replaces sm.8 for every team, so it still needs Bob's word (R-18; asked as Q-18).
- Cut-off: an S-52 item not integrated by 09:00 CST is dropped from this release and filed for the next one (a PR
  fix not ready then becomes a known limit in that PR's body), so the gate, promote and pack fit before 11:00.
  Ceremony that adds nothing is dropped (R-10); the gate is not.
- Reason: the governing spec has been shipped since sm.8; this closes the review-fix tail with a date.
- Not chosen: a later date; letting the gate wait for late items.
- Still binding: R-18, R-21, R-22, R-24, R-25, S-52.
- Work implied: Orc-Codegraph plans backward from 11:00 and reports at the deadline what is done, what is not, and
  why; Designer-Codegraph refreshes SPEC §8 at the promote.
- Done: 2026-11-04 08:45 CST, Orc-Codegraph (#2176; design/Orc-Codegraph/ledger/reports/r29-status-2026-11-04.md):
  S-52's 20 features integrated, gate green after one test-only fixture fix, ours ff092584, 1.6.2-sm.11 packed and
  tarball-checked, the S-52 PR pushes made (#3199, #3207 to #3210, #3209 with its blast fix). SPEC §8 updated (bae49b10).
  Not done: the install (Q-18, Bob).

## R-30. Install sm.11; running sessions reconnect instead of restarting (answers Q-18)
- Date: 2026-11-04 ~10:50 CST / Bob, direct: after the upgrade is installed and the old server is stopped, run
  codeteam's `codeteam-type-all "/mcp reconnect codegraph"`. Given after Designer explained that a running
  session's `serve --mcp` helper keeps the version it started with, and serves in-process, read-only, when the
  server is another version.
- Question: Q-18, install 1.6.2-sm.11 (ours ff092584) in place of sm.8; and how do sessions already running move to
  the new server without a restart?
- Ruling: yes, by this procedure: (1) install the sm.11 tarball and confirm the version, the tools and telemetry
  off (R-6); (2) stop the old sm.8 server explicitly (a newer `-sm.N` launcher never replaces an older one on its
  own: `isOlderRelease` compares plain MAJOR.MINOR.PATCH only); (3) run Bob's `codeteam-type-all "/mcp reconnect
  codegraph"` (codeteam's bin), which types the reconnect into every running session of every team that is up and
  not halted, once its turn has ended and its box is empty, retries busy ones every 20 s for up to 20 minutes
  (`--wait <min>`) and lists any it could not reach (`--teams`, `--dry-run`). Subagents share their session's
  connection. (4) Every team answers a call. A failed check rolls back to sm.8 by the same steps. Bob checked the
  reconnect on a scratch session ("Successfully reconnected to codegraph") and told Orc-Codeteam to add the step to
  codeteam's install procedure.
- Reason: the reconnect removes the one cost of the install (running sessions stuck in-process on sm.8).
- Not chosen: restarting sessions; leaving them in-process until they end; a product change making an old helper
  re-launch itself from a newer install.
- Work implied: Orc-Codegraph installs sm.11 by the steps above and reports the version, the checks and any
  session the command could not reach; fleet adds steps (2) and (3) to fleet/rollout/global-install.md and
  rollback.md.
- Confirmed: 2026-11-04 10:57 CST, Bob, direct ("install is approved").
- Done: 2026-11-04, Orc-Codegraph (#2190; design/Orc-Codegraph/ledger/reports/release-gate-sm11.md, Install):
  1.6.2-sm.11 installed, telemetry off, sm.8 server stopped, the server is sm.11; all 8 teams answer with 10 tools;
  the reconnect reached 38 sessions, plus aimodel's other four on retry; promoted features approved. Not reached:
  aimodel/Coord-research, busy through the 60-minute retry (ended 12:18, #2237), so it answers in-process on sm.8
  until it idles and is reconnected or restarts. Fleet's runbook steps landed on ours 4f7bfc21 after Kong's review.

## R-31. The official public fork: codedaptive/codegraph-hub, tracking upstream monthly; the PR effort finishes
- Date: 2026-11-04 ~11:10 CST / Bob, direct: "that project has its own agenda. I want to finish the PR effort but
  let's make an Official public fork on codedaptive/codegraph-hub; we'll declare ourselves as tracking the main
  project but maintaining our unique feature set, with a monthly update, unless someone reports an issue they need
  fixed more timely."
- Question: upstream has not answered any of the 14 PRs or 3 issues since 2026-11-01; what is our public stance?
- Ruling: (1) The official public fork is `codedaptive/codegraph-hub`: the existing public fork
  `codedaptive/codegraph-sharedserver` (R-17) is renamed to it, since an organisation holds one fork of a repository
  and GitHub redirects the old name. Its README opens by saying it tracks `colbymchenry/codegraph` and keeps its own
  feature set, is updated monthly, and takes issues (Issues turned on); a reported issue that needs a sooner fix
  gets one out of cycle. (2) Monthly update: current upstream merged into ours, the whole-suite gate, then the hub's
  main brought to that `ours` with SPEC-upstream §4's exclusions and R-19's rules, and the update tagged. The first
  update is now, from sm.11. (3) The PR effort finishes: S-53's restack makes the five conflicting PRs mergeable;
  after that the 14 PRs stay open as offered with no further pushes, restacks or bot replies; if the maintainer
  himself comments, upstream-prs answers him. (4) Upstream issue #3211's body is edited to name the hub; no new
  comment (R-25).
- Reason: upstream sets its own course; the hub gives users a maintained home for the features on a stated cadence.
- Not chosen: a second, separate repository (GitHub allows one fork per organisation; the rename keeps the fork
  link and the old links); npm publication of the hub (not asked); continuing to chase the PRs.
- Supersedes: R-17's fork name and its open-ended PR follow-up (R-17's PRs and issues stand as offered).
- Expanded in docs/SPEC-upstream.md §4 and §7. Work implied: Orc-Codegraph routes the rename, README, Issues,
  #3211 body edit and the first update (upstream-prs, which keeps the fork checkout, is the natural owner) after
  S-53, and fixes the monthly date.
- Amended 2026-11-04 (Bob): "The main readme should simply and clearly communicate exactly what features we have
  added and how to use them. We carry the same license as the source." The hub's README leads with one entry per
  added feature (what it does in one sentence, then how to use it, with an example), the fixes carried ahead of
  upstream with their PR numbers, install and setup, and where it differs from upstream's defaults; upstream's
  README follows unchanged (superseded the same day: kept as a linked copy, R-32). The hub keeps upstream's MIT `LICENSE` as is and says so (SPEC-upstream §7 items 3-4).

## R-32. `codegraph upgrade` and the update notice use the hub's releases, never upstream's
- Date: 2026-11-04 / Bob, direct ("I think we need to change the upgrade command to pull our version for safety?";
  then "agreed. Go" to Designer's design below).
- Question: our builds' `codegraph upgrade` installs upstream's package (`src/upgrade/index.ts:35-36`: npm
  `@colbymchenry/codegraph@latest`, or upstream's `install.sh` for a bundle), and the update check reads upstream's
  releases: a prerelease sorts below its release (`compareVersions`, :255-257), so `1.6.2-sm.11` sees upstream
  `v1.6.2` as newer and every install with the check on tells its agents, in the MCP instructions and
  `codegraph_status`, to run `codegraph upgrade`. The prerelease part is compared as text, so `sm.11` sorts before
  `sm.9`. This machine is shielded only by `DO_NOT_TRACK=1`.
- Ruling: (1) each monthly hub update is a GitHub release of `codedaptive/codegraph-hub`, tagged with the build's
  version (`v1.6.2-sm.N`), the packed build attached; (2) `codegraph upgrade` installs the hub's latest release, or
  the hub version named, and never installs upstream's package or runs upstream's install script; a source
  checkout keeps "git pull && npm run build"; (3) the update check and notice read the hub's releases; (4) the
  `-sm.N` suffix stays and its number compares as a number (sm.9 before sm.11); a rename (e.g. `-hub.N`) is not
  made, since "hub" sorts before "sm" and an sm.11 install would never see it as newer; (5) the first hub release is
  sm.12, the first build with this fix; the rename and README go ahead without waiting. With it, the hub README
  question is settled as Designer recommended: upstream's README is a linked copy, `UPSTREAM-README.md`, not
  appended (SPEC-upstream §7 item 3).
- Reason: an agent obeying today's notice, or a user running `codegraph upgrade`, replaces the hub with upstream.
- Not chosen: keeping upstream's upgrade path; turning the update check off by default (it would hide the hub's
  own releases); renaming the version suffix.
- Expanded in docs/SPEC.md §6 and SPEC-upstream §7 items 5 and 9. Work implied: Orc-Codegraph routes the code
  change (`src/upgrade/` is upstream-owned: hook-in edits only, with a fork README row), red tests first for each of
  (2)-(4), the gate, sm.12 promoted and packed, then the hub's first release from it. Installing sm.12 on this
  machine waits for Bob (R-18).

## R-33. Install sm.12 when it is ready, with the reconnect script
- Date: 2026-11-04 12:20 CST / Bob, direct ("install sm.12 and use the script to do the mcp reconnects").
- Question: R-32 left installing sm.12 (the build with the hub-release upgrade fix) to Bob (R-18). sm.12 is not
  built yet (releases/ ends at sm.11; this machine runs 1.6.2-sm.11).
- Ruling: install sm.12 on this machine as soon as its whole-suite gate is green and it is packed and
  tarball-checked; no further go-ahead. By the runbook on ours (fleet/rollout/global-install.md, 4f7bfc21): install
  and check the version, tools and telemetry off; stop the sm.11 server; run codeteam's `codeteam-type-all
  "/mcp reconnect codegraph"` for every running session; every team answers. A failed check rolls back to sm.11
  by the same steps.
- Reason: Bob's word; the reconnect makes an install cheap for running sessions.
- Not chosen: waiting for the hub's first release before installing here.
- Still binding: R-32 (sm.12 carries the upgrade fix and is the hub's first release), R-21, R-22.
- Work implied: Orc-Codegraph installs sm.12 when it is packed and reports the version, the checks and any session
  the script could not reach.
