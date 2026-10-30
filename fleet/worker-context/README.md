# worker-context — genuine product context and owner provisioning

Proposal for Orc-Codegraph #1164, 2026-10-30. Fleet prepared files only; no shared
application, engine implementation, runtime investigation, policy change or new
test run. S-43 / Orc #1170 confirms the product authority/source placement;
Orc applies the approved context. An approved proposal is not available context.

## Exact files and authority

| Proposed file here | New canonical destination |
|---|---|
| `PROJECT.md` | `/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog/products/codegraph/PROJECT.md` |
| `toolchain-typescript.md` | `/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog/products/codegraph/rules/toolchain-typescript.md` |

`catalog.patch` adds exactly those two files relative to the catalog root. Both
contain substantive CodeGraph context, not pointers/stubs or copied foreign-port
rules. No generated agent, template, model, effort, permission or manifest changes
are proposed. Existing root guidance and product rules remain authoritative.

Source facts used:

- Root `AGENTS.md:3,7-11,60-91`: technical authority, product, layered pipeline and
  module map; `:15-56,58,79`: build/test meaning and source-runtime requirements.
- Catalog `products/codegraph/AGENTS.md:3-8,12-26,28-54`: authority split, fork,
  one TypeScript/Node port, commands, ownership and shared-state boundaries.
- Catalog `products/codegraph/rules/team-layout.md:9-17`: primary checkout,
  worktree discipline and generated-context ownership.
- Fork `Makefile:1-9,20-34,36-55,60-69`: injected zone targets, record/filter
  restrictions, local typecheck/test mapping and slow-test command behavior.
- Catalog `templates/bilby.md:154-161`: both context reads are mandatory; absent
  PROJECT explicitly stops the worker. This proposal does not change that rule.
- Owner evidence:
  `/Users/bob/devlop/team-codegraph/design/Orc-Codegraph/ledger/reports/wp1-worker-context-provisioning.md:5-20`.
  Existing A/B work and failing-before records stay preserved; no rerun is needed
  to provide documents.

The product guide's old upper Node-bound note is not copied into the new rule:
that guide expressly defers technical facts to root AGENTS, which documents no
upper Node cap and the `node:sqlite` source-runtime requirement. No new version
pin or compiler policy is introduced.

## Exact source-to-primary-to-worktree chain

Canonical root, verified absolute:
`/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog`.

1. With canonical placement confirmed by S-43, the catalog owner adds the two
   approved canonical files.
   In an approved catalog repository worktree, the patch form is
   `git apply --check --directory=shared/agent_catalog <absolute-package>/catalog.patch`,
   then the same command without `--check`. Promote the approved source normally;
   do not apply a second private copy directly inside a request worktree.
2. Publish the genuine canonical product documents explicitly to CodeGraph's
   existing primary team home: `team/claude/PROJECT.md` and
   `team/claude/rules/toolchain-typescript.md`. Catalog `Makefile:21-29` exports
   rules/skills and product AGENTS, not PROJECT. Copy only these two CodeGraph
   files; do not run `make install-rules` (which uses `rsync --delete`) or
   regenerate the catalog/agents/settings.
3. Primary checkout `.claude/PROJECT.md` links to the home PROJECT. Its existing
   `.claude/rules -> team/claude/rules` exposes the toolchain file unchanged.
4. Preserved worker `.claude/PROJECT.md` links from PRIMARY; its existing rules
   link already points to PRIMARY's `.claude/rules`. No skills, memory, hooks,
   settings or per-session files are replaced or moved.

Current codeteam source supports the explicit recipe, not an automatic-install
claim: `bin/codeteam:119` omits PROJECT from `CLAUDE_ENTRIES`; `:819-849` provisions
that list and preserves the primary checkout, while `:871-885` keeps an existing
team home. Merely rerunning a generic initializer or installing product rules
would not supply the whole chain. The named PROJECT link is an owner bootstrap
addendum for each relevant worktree. No shared provisioner modification is part
of #1164. Future worktrees require that same addendum until an owner separately
integrates it; never assume the two paths are present.

## Owner-only recipe (not executed by fleet)

Run only after the approved canonical files are present. This recipe targets the
specific preserved worktree; for a later worktree, the owner substitutes only its
absolute WT path after normal agents/rules/hooks bootstrap. All parents must
already exist. Existing equal documents/resolving links stay untouched; a
conflict, wrong rules link or dangling entry stops before provisioning. There is
no force-link, recursive copy, settings edit or broad rule installation.

```sh
set -eu
CAT=/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog
SRC="$CAT/products/codegraph"
HOME_CTX=/Users/bob/devlop/team-codegraph/team/claude
PRIMARY=/Users/bob/devlop/team-codegraph/design/codegraph-ours
WT=/Users/bob/devlop/team-codegraph/workcrews/host/requests/agent-a3608fb98395a45c1

fail() { printf '%s\n' "$*" >&2; exit 1; }
# Preflight ALL existing destinations before writing either document/link.
check_document() {
  test -f "$1" && test -r "$1" || fail "missing approved source: $1"
  if test -e "$2" || test -L "$2"; then
    test -f "$2" && cmp -s "$1" "$2" || fail "context conflict: $2"
  fi
}
for dir in "$HOME_CTX" "$HOME_CTX/rules" "$PRIMARY/.claude" "$WT/.claude"; do
  test -d "$dir" || fail "normal bootstrap missing: $dir"
done
test -d "$PRIMARY/.claude/rules" &&
  test "$PRIMARY/.claude/rules" -ef "$HOME_CTX/rules" || fail "primary rules differ"
test -d "$WT/.claude/rules" &&
  test "$WT/.claude/rules" -ef "$PRIMARY/.claude/rules" || fail "worker rules differ"
check_document "$SRC/PROJECT.md" "$HOME_CTX/PROJECT.md"
check_document "$SRC/rules/toolchain-typescript.md" "$HOME_CTX/rules/toolchain-typescript.md"
check_document "$SRC/PROJECT.md" "$PRIMARY/.claude/PROJECT.md"
check_document "$SRC/PROJECT.md" "$WT/.claude/PROJECT.md"

# cp -n will not clobber an entry created concurrently; final comparisons detect conflicts.
cp -n "$SRC/PROJECT.md" "$HOME_CTX/PROJECT.md"
cp -n "$SRC/rules/toolchain-typescript.md" "$HOME_CTX/rules/toolchain-typescript.md"
if ! test -e "$PRIMARY/.claude/PROJECT.md" && ! test -L "$PRIMARY/.claude/PROJECT.md"; then
  ln -s "$HOME_CTX/PROJECT.md" "$PRIMARY/.claude/PROJECT.md"
fi
if ! test -e "$WT/.claude/PROJECT.md" && ! test -L "$WT/.claude/PROJECT.md"; then
  ln -s "$PRIMARY/.claude/PROJECT.md" "$WT/.claude/PROJECT.md"
fi
for root in "$HOME_CTX" "$PRIMARY/.claude" "$WT/.claude"; do
  test -r "$root/PROJECT.md" && cmp -s "$SRC/PROJECT.md" "$root/PROJECT.md" || fail "PROJECT unavailable/different: $root"
  test -r "$root/rules/toolchain-typescript.md" &&
    cmp -s "$SRC/rules/toolchain-typescript.md" "$root/rules/toolchain-typescript.md" || fail "TypeScript context unavailable/different: $root"
done
```

This is a non-clobbering context recipe, not a new shared security or concurrency
policy. If concurrent provisioning or a conflict stops it, do not force an
entry into place or roll back unrelated context. Reconcile the named entry with
its owner and repeat the read-only checks. Do not fill the gap with a stub.

## Actual resumption condition / evidence limit

The owner verifies both required paths in the preserved worktree are readable
and contain the approved genuine context. Then the same lead and A/B coders read
them before resuming their existing contracts. No new coder, waived stop, worker
permission/model change, fresh implementation baseline or test run is implied.

Fleet's evidence is source inspection and documentation review only. Fleet has
not run this provisioning recipe, generated agents, rebuilt the engine, executed
old R-9 gates, or claimed that the blocked workers have resumed.
