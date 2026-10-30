# TypeScript / Node build and test context

One port: TypeScript on Node. Use the repository's checked-in package,
TypeScript and Vitest configuration; this rule adds no compiler flags,
version pin, environment override or model/permission policy. Root
`AGENTS.md` is the technical authority: package engines are Node >=20 with
no upper bound, while running this source tree requires Node >=22.5 for
`node:sqlite`. Node 25 and later are supported; impose no upper ceiling.
Do not change the toolchain to bypass a failure.

## Commands and their meaning

Run from the assigned worktree root, only for the zone and checks authorized
by the request. A worktree needs `npm ci` once before its first test;
dependency installation is not a build or a passing test.

Codeteam injects `MAKEFILES=<codeteam>/zone/zone.mk`. The root Makefile maps
its TypeScript targets to local `npx --no-install` commands:

| Purpose | Command | Evidence / scope |
|---|---|---|
| Read an existing test record | `make zone-test-status` | A record, not a new test run; check its current/stale state. |
| Type-check | `make typecheck` | `tsc --noEmit -p .`; no emitted build or runtime tests. |
| Record one authorized test file/folder | `make zone-test-one DIR=<test-path>` | Unfiltered recorded run; no `TEST` or nonempty `CODEGRAPH_KERNEL*` override. |
| Filter one authorized test | `make test-one DIR=<test-path> TEST="<name-pattern>"` | Vitest `-t`; intentionally unrecorded, not an unfiltered-suite pass. |
| List slow tests by executing the named scope | `make test-times DIR=<test-path>` | Runs tests; not a free metadata lookup. Use only when requested. |

`make zone-test` also rejects nonempty `TEST` / `CODEGRAPH_KERNEL*` overrides.
Do not disguise filters through other-port arguments or reuse a filtered
result as an unfiltered record. There is no declared `make help` target.
Neither a missing help target nor missing dependencies clears a required gate.

Root `AGENTS.md` defines the full build as `npm run build`: TypeScript plus
SQL/grammar assets and the viewer under `dist/`. The component-library build
is separate. Do not run a full build just to supply worker context; obtain
the appropriate owner authorization when a request actually needs `dist/`.
Whole-suite/integration work belongs to the orchestrator, not a lane checking
another zone.

Use existing current records rather than rerunning unchanged checks. Report
the actual command, exit status and output/counts when tests are authorized;
compilation, dependency setup and expected failing-before evidence are not
implementation acceptance. A documentation/provisioning proposal alone does
not clear a missing-context stop: both required context paths must actually
be readable before the same workers resume.
