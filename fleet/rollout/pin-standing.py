#!/usr/bin/env python3
"""fleet/rollout/pin-standing.py [--apply | --undo] [--log <file>] [--codegraph <path>] [--teams <dir>]

The go-live pin step (settled S-34): every codeteam team's tier checkouts (design, exchange,
integration) and standing lane worktrees, pinned in CodeGraph with `codegraph project pin`.
Request worktrees are never listed: they stay unpinned (S-34).

The list comes from codeteam itself (its Team class, tier_wt and lane_wt in bin/codeteam), read
at run time, so it matches the worktrees that exist when the step runs rather than a list
written earlier. By default (no --apply, no --undo) it only prints the list, one `path<TAB>state`
line per worktree, and changes nothing. A worktree whose folder does not exist (a tier a lab team never created) is reported
and skipped. With --apply it pins each existing one and exits 1 if any pin failed.

Pinning also registers a project that was not registered. --apply writes one `root<TAB>state` line per
pin to the log (default pin-standing.log), the state from `codegraph project list --json` taken before it
starts: new (not registered), registered, or pinned (already pinned). The log is appended to, and a
root already in it keeps its first state, so re-running --apply after a partial failure leaves the
undo record of the first run intact. --undo reads that log and puts
each back: it unpins `new` and `registered` roots, and unregisters (`codegraph project remove`, which
deletes no file) only the `new` ones; a root that was already pinned is left as it was.
"""
import argparse
import glob
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CODETEAM = Path("/Users/bob/devlop/codeteam")


def load_codeteam():
    """bin/codeteam as a module (it runs main() only under __main__)."""
    loader = importlib.machinery.SourceFileLoader("codeteam_bin", str(CODETEAM / "bin" / "codeteam"))
    spec = importlib.util.spec_from_loader("codeteam_bin", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def standing_worktrees(ct, teams_dir: Path):
    """(team, kind, path) for each tier checkout and standing lane worktree, team by team."""
    for manifest in sorted(glob.glob(str(teams_dir / "*.toml"))):
        t = ct.Team(manifest)
        team = Path(manifest).stem
        tiers = ["design"] if t.lab else ["design", "exchange", "integration"]
        for tier in tiers:
            yield team, f"tier {tier}", Path(t.tier_wt(tier))
        for name, rec in ct.load_json(t.team_file, {}).get("lanes", {}).items():
            yield team, f"lane {name}", Path(ct.lane_wt(t, name, rec))


def read_log(path: Path) -> dict:
    """root -> the state its first --apply recorded (later lines for the same root are ignored)."""
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "\t" in line:
                root, state = line.split("\t", 1)
                out.setdefault(root, state)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="pin them (default: list only)")
    mode.add_argument("--undo", action="store_true", help="reverse an --apply from its log")
    ap.add_argument("--log", default="pin-standing.log", help="the --apply record --undo reads")
    ap.add_argument("--codegraph", default=shutil.which("codegraph") or "codegraph")
    ap.add_argument("--teams", default=str(CODETEAM / "teams"), help="folder of codeteam manifests")
    a = ap.parse_args()
    env = dict(os.environ, DO_NOT_TRACK="1")

    def cg(*args):
        """Run the codegraph CLI; (ok, output). A CLI that cannot start counts as a failure."""
        try:
            r = subprocess.run([a.codegraph, *args], capture_output=True, text=True, env=env)
        except OSError as e:
            return False, str(e)
        return r.returncode == 0, (r.stdout if r.returncode == 0 else (r.stderr or r.stdout)).strip()

    if a.undo:
        failed = 0
        for root, state in read_log(Path(a.log)).items():
            ok, msg = True, ""
            if state != "pinned":
                ok, msg = cg("project", "unpin", root)
            if ok and state == "new":
                ok, msg = cg("project", "remove", root)
            failed += not ok
            print(f"{root}\t{'undone' if ok else 'FAILED: ' + msg} ({state})")
        sys.exit(1 if failed else 0)

    ct = load_codeteam()
    before = {}
    if a.apply:
        ok, out = cg("project", "list", "--json")
        if not ok:
            sys.exit(f"codegraph project list --json failed: {out}")
        # The registry records, as JSON: root -> its flags bitmap (project-registry.ts).
        before = {p["root"]: int(p.get("flags", 0)) for p in json.loads(out)}
        logged = read_log(Path(a.log))
        log = open(a.log, "a")
    failed = 0
    for team, kind, path in standing_worktrees(ct, Path(a.teams)):
        if not path.is_dir():
            print(f"{path}\tmissing ({team} {kind}): skipped")
            continue
        if not a.apply:
            print(f"{path}\tto pin ({team} {kind})")
            continue
        ok, out = cg("project", "pin", str(path))
        if not ok:
            failed += 1
            print(f"{path}\tFAILED ({team} {kind}): {out}")
            continue
        # `codegraph project pin` always pins the path's git worktree root (R-46) and prints it: `Pinned <root>`.
        root = out.split("Pinned ", 1)[1].strip() if "Pinned " in out else str(path)
        if root not in logged:
            # PROJECT_FLAG_PINNED is bit 0 of the record's flags (project-registry.ts).
            state = "new" if root not in before else ("pinned" if before[root] & (1 << 0) else "registered")
            log.write(f"{root}\t{state}\n")
            log.flush()
            logged[root] = state
        print(f"{path}\tpinned ({team} {kind})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
