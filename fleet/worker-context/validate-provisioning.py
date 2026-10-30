#!/usr/bin/env python3
"""Exercise the documented owner recipe only in temporary filesystem fixtures."""

import hashlib
import os
from pathlib import Path
import platform
import shlex
import stat
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ASSIGNMENTS = {
    "CAT=/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog": "catalog",
    "HOME_CTX=/Users/bob/devlop/team-codegraph/team/claude": "home",
    "PRIMARY=/Users/bob/devlop/team-codegraph/design/codegraph-ours": "primary",
    "WT=/Users/bob/devlop/team-codegraph/workcrews/host/requests/agent-a3608fb98395a45c1": "worker",
}


def recipe():
    # Extract the actual Markdown example, not a second implementation of it.
    blocks = []
    current = None
    for line in (HERE / "README.md").read_text().splitlines(keepends=True):
        marker = line.rstrip("\r\n")
        if current is None and marker == "```sh":
            current = []
        elif current is not None and marker == "```":
            blocks.append("".join(current))
            current = None
        elif current is not None:
            current.append(line)
    assert current is None and len(blocks) == 1, "expected one complete owner recipe"
    return blocks[0]


def snapshot(root):
    result = {}
    # Directory mtimes/sizes naturally change when entries are added; retain
    # identity/mode there, and full content/mtime identity for existing files.
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            info = path.lstat()
            key = str(path.relative_to(root))
            if stat.S_ISDIR(info.st_mode):
                result[key] = (info.st_mode, info.st_ino)
            elif stat.S_ISLNK(info.st_mode):
                result[key] = (info.st_mode, info.st_ino, info.st_mtime_ns, os.readlink(path))
            else:
                result[key] = (
                    info.st_mode, info.st_ino, info.st_mtime_ns,
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                )
    return result


def put(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def check_case(base, name, source):
    root = base / name
    roots = {name: root / name for name in ASSIGNMENTS.values()}
    canonical = roots["catalog"] / "products/codegraph"
    home = roots["home"]
    primary = roots["primary"] / ".claude"
    worker = roots["worker"] / ".claude"
    project = (HERE / "PROJECT.md").read_bytes()
    toolchain = (HERE / "toolchain-typescript.md").read_bytes()
    put(canonical / "PROJECT.md", project)
    put(canonical / "rules/toolchain-typescript.md", toolchain)
    (home / "rules").mkdir(parents=True)
    primary.mkdir(parents=True)
    worker.mkdir(parents=True)
    (primary / "rules").symlink_to(home / "rules")
    (worker / "rules").symlink_to(primary / "rules")
    put(home / "rules/product.md", b"unrelated product doctrine\n")
    put(home / "settings.json", b'{"untouched": true}\n')
    for folder in (primary, worker):
        put(folder / "skills/sentinel.txt", b"tracked skills stay put\n")
        put(folder / "agent-memory/sentinel.txt", b"memory stays put\n")
        put(folder / "settings.local.json", b'{"local": true}\n')

    if name in ("all-equal", "published-home-missing-links"):
        put(home / "PROJECT.md", project)
        put(home / "rules/toolchain-typescript.md", toolchain)
    if name == "all-equal":
        (primary / "PROJECT.md").symlink_to(home / "PROJECT.md")
        (worker / "PROJECT.md").symlink_to(primary / "PROJECT.md")
    elif name == "conflict":
        put(home / "PROJECT.md", b"conflicting document must survive\n")
    elif name == "dangling":
        (worker / "PROJECT.md").symlink_to(root / "absent-document")
    elif name == "wrong-rules":
        (worker / "rules").unlink()
        (worker / "rules").mkdir()

    rendered = source
    # Only the four root assignments change. All shell logic runs verbatim.
    for assignment, key in ASSIGNMENTS.items():
        assert rendered.count(assignment + "\n") == 1, assignment
        replacement = assignment.split("=", 1)[0] + "=" + shlex.quote(str(roots[key]))
        rendered = rendered.replace(assignment, replacement, 1)
    assert all(assignment not in rendered for assignment in ASSIGNMENTS)
    script = root / "owner-recipe.sh"
    script.write_text(rendered)
    before = snapshot(root)
    execution = subprocess.run(
        ["/bin/sh", str(script)], cwd=HERE, text=True, capture_output=True,
    )
    expected_exit = 1 if name in ("conflict", "dangling", "wrong-rules") else 0
    assert execution.returncode == expected_exit, (
        name, execution.returncode, execution.stdout, execution.stderr,
    )
    after = snapshot(root)
    assert all(after.get(path) == value for path, value in before.items()), name
    additions = set(after) - set(before)
    expected = set()
    if name == "fresh":
        expected = {"home/PROJECT.md", "home/rules/toolchain-typescript.md"}
    if name in ("fresh", "published-home-missing-links"):
        expected |= {"primary/.claude/PROJECT.md", "worker/.claude/PROJECT.md"}
    assert additions == expected, (name, additions, expected)
    if expected_exit == 0:
        for folder in (home, primary, worker):
            assert (folder / "PROJECT.md").read_bytes() == project, name
            assert (folder / "rules/toolchain-typescript.md").read_bytes() == toolchain, name
        assert os.readlink(primary / "PROJECT.md") == str(home / "PROJECT.md"), name
        assert os.readlink(worker / "PROJECT.md") == str(primary / "PROJECT.md"), name
    else:
        reason = "worker rules differ" if name == "wrong-rules" else "context conflict"
        assert reason in execution.stderr, (name, execution.stderr)
    print(f"PASS {name}: exit={execution.returncode}, new_entries={len(additions)}, existing_entries_preserved")


def main():
    source = recipe()
    print(f"Platform: {platform.system()} {platform.machine()}")
    print(f"Recipe SHA256: {hashlib.sha256(source.encode()).hexdigest()}")
    # Spaces in fixture roots also verify that assignment quoting is retained.
    with tempfile.TemporaryDirectory(prefix="worker-context fixtures ") as folder:
        for name in ("fresh", "all-equal", "published-home-missing-links", "conflict", "dangling", "wrong-rules"):
            check_case(Path(folder), name, source)
    print("PASS: 6 disposable provisioning cases (3 success states, 3 refusals); no shared application or engine tests")


if __name__ == "__main__":
    main()
