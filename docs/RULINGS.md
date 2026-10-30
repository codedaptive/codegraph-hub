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
