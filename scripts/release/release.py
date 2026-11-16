#!/usr/bin/env python3
"""Release checks for .github/workflows/release.yml.

check    PR into main: exit 1 listing every problem, or print the tag vX.Y.Z.
publish  push to main: exit 1 on any tree problem; print nothing when the tag
         exists; otherwise write the release notes and print the tag.
"""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PLAIN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# The version fields checked per manifest file name; "*" walks every list item.
FIELDS = {
    "plugin.json": [("version",)],
    "package.json": [("version",)],
    "package-lock.json": [("version",), ("packages", "", "version")],
    "marketplace.json": [("version",), ("metadata", "version"), ("plugins", "*", "version")],
}


def changelog_release(root: Path):
    """Return (version, notes, problems) from the first '## ' section of CHANGELOG.md."""
    try:
        lines = (root / "CHANGELOG.md").read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None, None, ["CHANGELOG.md is missing"]
    # Every line starting with '#' counts as a heading and only the '# Changelog' title may precede the release
    # heading, so a mistyped release heading fails instead of falling through to an older section.
    heads = [i for i, line in enumerate(lines) if line.lstrip().startswith("#")]
    if heads and lines[heads[0]] == "# Changelog":
        heads = heads[1:]
    if not heads:
        return None, None, ["CHANGELOG.md has no '## ' heading"]
    heading = lines[heads[0]]
    if not (heading.startswith("## ") and PLAIN.fullmatch(heading[3:])):
        return None, None, [f"CHANGELOG.md: top section '{heading}' (the first heading after '# Changelog') is not a plain '## X.Y.Z' heading"]
    end = next((i for i in heads[1:] if lines[i].startswith("## ")), len(lines))
    notes = "\n".join(lines[heads[0] + 1:end]).strip()
    if not notes:
        return heading[3:], None, [f"CHANGELOG.md: section '{heading}' is empty"]
    return heading[3:], notes + "\n", []


def field_values(data, path, label=""):
    """Yield (label, value) for each present field along path."""
    if not path:
        yield label, data
        return
    key, rest = path[0], path[1:]
    if key == "*" and isinstance(data, list):
        for i, item in enumerate(data):
            yield from field_values(item, rest, f"{label}[{i}]")
    elif key != "*" and isinstance(data, dict) and key in data:
        part = f".{key}" if key else '[""]'
        yield from field_values(data[key], rest, f"{label}{part}".lstrip("."))


def not_json(constant):
    """Python's json accepts NaN and Infinity; JSON does not."""
    raise ValueError(f"{constant} is not JSON")


def manifest_problems(root: Path):
    """Problems in the version fields of every tracked manifest."""
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, text=True)
    if listed.returncode:
        return [f"could not list the tracked files: {listed.stderr.strip()}"]
    problems = []
    for name in sorted(n for n in listed.stdout.split("\0") if Path(n).name in FIELDS):
        try:
            data = json.loads((root / name).read_text(encoding="utf-8"), parse_constant=not_json)
        except (OSError, ValueError) as error:
            problems.append(f"{name}: not valid JSON ({error})")
            continue
        for path in FIELDS[Path(name).name]:
            for label, value in field_values(data, path):
                if not (isinstance(value, str) and PLAIN.fullmatch(value)):
                    problems.append(f"{name}: {label} is {value!r}, not a plain X.Y.Z version")
    return problems


def tag_exists(root: Path, tag: str):
    """True or False, or None when origin cannot be read."""
    ref = f"refs/tags/{tag}"
    listed = subprocess.run(["git", "ls-remote", "--tags", "origin", ref], cwd=root, capture_output=True, text=True)
    if listed.returncode:
        return None
    # ls-remote matches pattern suffixes, so compare the exact ref (and its peeled form).
    return any(line.split("\t")[-1] in (ref, ref + "^{}") for line in listed.stdout.splitlines())


def main(argv=None, root: Path = Path(".")) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    publish = commands.add_parser("publish")
    publish.add_argument("--notes-file", required=True, type=Path)
    args = parser.parse_args(argv)

    version, notes, problems = changelog_release(root)
    problems += manifest_problems(root)
    tag = f"v{version}" if version else None
    exists = tag_exists(root, tag) if tag else False
    if exists is None:
        problems.append("could not list the tags on origin")
    elif exists and args.command == "check":
        problems.append(f"tag {tag} already exists on origin")
    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        return 1
    if exists:
        print(f"{tag} already exists; nothing to publish", file=sys.stderr)
        return 0
    if args.command == "publish":
        args.notes_file.write_text(notes, encoding="utf-8")
    print(tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
