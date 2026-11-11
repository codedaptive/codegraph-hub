# Fork-only Makefile (codedaptive/codegraph; never offered upstream): the test targets codeteam's zone.mk
# calls, mapped onto the npx calls in team/claude/rules/product.md "Test calls". codeteam exports
# MAKEFILES=<codeteam>/zone/zone.mk, so make reads zone.mk first and this file second. zone.mk's zone-test
# and zone-test-one record a run of the targets below (zone-test through ZONE_TEST); zone-test-status reads
# those records.
#
#   make test-one DIR=<test file or folder> [TEST="<name regex>"] [GROUP=unit|integration|validation|all]  one file or folder through vitest (TEST is vitest -t)
#   make typecheck                                                                                        the push gate (tsc --noEmit)
#   make test-times DIR=<test file or folder> [GROUP=unit|integration|validation|all]                     tests over 5 s, slowest first
#
# GROUP defaults to unit; a file's group comes from its suffix or test-groups.json (fleet/test-groups.mts).
# A worktree needs `npm ci` once before its first test; every target says so instead of failing in npx.

.PHONY: test-one typecheck test-times
NPX := npx --no-install
# DIR and TEST reach the recipes as environment variables ("$$DIR"), never pasted into the shell line, so a
# quote or a backtick in a path or a test name arrives at vitest as typed. A $ in a command-line value is
# still make's: write $$ there (TEST='a $$b'); a value from the environment needs no escaping.
export DIR TEST
GROUP ?= unit
# Only GROUP selects the test group; command-line or environment CODEGRAPH_TEST_GROUP cannot bypass it.
override CODEGRAPH_TEST_GROUP = $(GROUP)
export CODEGRAPH_TEST_GROUP

# zone.mk's zone-test-one key includes DIR, SWIFT_TEST_ARGS and CARGO_TEST_ARGS, not TEST or GROUP.
# A TEST filter or non-unit GROUP could be recorded under the unfiltered unit key and replayed later.
# Both are also refused for zone-test, whose record likewise does not distinguish TEST or GROUP.
# The same holds for the extraction-path switches: CODEGRAPH_KERNEL=0 sends every file to the TypeScript (wasm)
# extractors instead of the Rust kernel, and CODEGRAPH_KERNEL_<PASS>=0 turns one kernel pass off. A record taken
# on one path would replay as if it covered the other, so any non-empty CODEGRAPH_KERNEL* (command line or
# environment) is refused there too.
ifneq ($(filter zone-test-one zone-test,$(MAKECMDGOALS)),)
ifneq ($(TEST),)
$(error TEST is not part of zone-test-one's record key; run `make test-one DIR=... TEST=...` for a filtered, unrecorded run)
endif
ifneq ($(GROUP),unit)
$(error GROUP is not part of zone-test-one's record key; run `make test-one DIR=... GROUP=...` for an unrecorded run of another group)
endif
KERNEL_SET := $(strip $(foreach v,$(filter CODEGRAPH_KERNEL%,$(.VARIABLES)),$(if $(strip $($(v))),$(v))))
ifneq ($(KERNEL_SET),)
$(error $(KERNEL_SET) is not part of zone-test-one's record key; unset it here, or run `make test-one DIR=...` with it for a path-specific, unrecorded run)
endif
endif

# Every codegraph lane's zone is the whole repo (CODETEAM_ZONE="."), so zone.mk's default ZONE_TEST
# (test-one on the zone, then on <zone>/rust) would run the whole suite and then a folder that does not
# exist. When the manifest gives the lane no `test` (ZONE_TEST then comes from zone.mk's default, origin
# "file"), the zone suite is the type check plus the test folders the lane owns (CODETEAM_OWNS entries
# under __tests__/), each through test-one. A lane `test` in the manifest (origin "environment") wins.
ifeq ($(origin ZONE_TEST),file)
ZONE_TEST_DIRS := $(filter __tests__/%,$(subst :, ,$(CODETEAM_OWNS)))
ZONE_TEST = $(MAKE) --no-print-directory -C $(ZONE_ROOT) typecheck$(foreach d,$(ZONE_TEST_DIRS), && $(MAKE) --no-print-directory -C $(ZONE_ROOT) test-one DIR=$(d))
endif

need_node_modules = @test -d node_modules || { echo "$@: no node_modules in this worktree; run npm ci once" >&2; exit 2; }

# A folder can hold no unit tests once its tests move to integration (S-65: real SQLite is integration), and
# the landing check runs each zone folder as unit; --passWithNoTests on the unit group only, so an empty
# integration or validation selection still fails.
test-one:
	@test -n "$$DIR" || { echo "test-one: set DIR (a test file or folder, e.g. __tests__/extensions/host)" >&2; exit 2; }
	$(need_node_modules)
	$(NPX) vitest run "$$DIR" $(if $(TEST),-t "$$TEST")$(if $(filter unit,$(GROUP)), --passWithNoTests)

typecheck:
	$(need_node_modules)
	$(NPX) tsc --noEmit -p .

# vitest's JSON report gives each test's duration; the zone rules ask for a stated reason on any over 5 s.
# The exit status is vitest's when it failed (the slow list still prints), else the report reader's; with no
# report, vitest's own output is shown.
test-times:
	@test -n "$$DIR" || { echo "test-times: set DIR" >&2; exit 2; }
	$(need_node_modules)
	@out="$$(mktemp)"; log="$$(mktemp)"; \
	$(NPX) vitest run "$$DIR" --reporter=json --outputFile="$$out" >"$$log" 2>&1; vrc=$$?; \
	if [ -s "$$out" ]; then \
	  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s=[]; for (const f of r.testResults) for (const t of f.assertionResults) if (t.duration > 5000) s.push([t.duration, f.name.replace(process.cwd() + "/", ""), t.fullName]); s.sort((a, b) => b[0] - a[0]); for (const [d, f, n] of s) console.log((d / 1000).toFixed(1) + " s  " + f + "  " + n); if (!s.length) console.log("no test over 5 s");' "$$out"; nrc=$$?; \
	else cat "$$log" >&2; nrc=1; fi; \
	if [ $$vrc -ne 0 ]; then echo "test-times: vitest exited $$vrc: tests failed or did not run" >&2; fi; \
	rm -f "$$out" "$$log"; if [ $$vrc -ne 0 ]; then exit $$vrc; fi; exit $$nrc
