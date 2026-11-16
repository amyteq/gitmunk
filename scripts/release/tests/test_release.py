"""Cases for the release check (PRs into main) and the publish step (pushes to main)."""
from __future__ import annotations
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release

GOOD_CHANGELOG = "# Changelog\n\n## 0.3.0\n\n- A change.\n\n## 0.2.0\n\n- Older.\n"


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


class Release(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.origin = Path(tmp.name, "origin.git")
        self.root = Path(tmp.name, "work")
        git(tmp.name, "init", "-q", "--bare", str(self.origin))
        git(tmp.name, "init", "-q", str(self.root))
        git(self.root, "remote", "add", "origin", str(self.origin))
        self.write("CHANGELOG.md", GOOD_CHANGELOG)
        self.write_json("plugins/a/.claude-plugin/plugin.json", {"name": "a", "version": "0.2.1"})
        self.write_json("plugins/a/package.json", {"name": "a", "version": "0.2.1"})
        self.write_json("plugins/a/package-lock.json", {
            "version": "0.2.1",
            "packages": {"": {"version": "0.2.1"}, "node_modules/dep": {"version": "1.0.0-rc.1"}},
        })
        self.write_json(".claude-plugin/marketplace.json", {"name": "m", "plugins": [{"name": "a"}]})

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(self.root, "add", name)

    def write_json(self, name, data):
        self.write(name, json.dumps(data))

    def tag(self, name):
        git(self.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c")
        git(self.root, "tag", name)
        git(self.root, "push", "-q", "origin", "HEAD:refs/heads/main", f"refs/tags/{name}")

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = release.main(list(argv), root=self.root)
        return code, out.getvalue(), err.getvalue()

    def assert_check_fails(self, *needles):
        code, out, err = self.run_cli("check")
        self.assertEqual((code, out), (1, ""), err)
        for needle in needles:
            self.assertIn(needle, err)
        return err

    # AC1 h and AC3: plain versions, a section and no tag pass; plugin versions need not match.
    def test_releasable_tree_passes_with_its_tag(self):
        self.assertEqual(self.run_cli("check")[:2], (0, "v0.3.0\n"))

    # AC1 a
    def test_unreleased_top_section_fails(self):
        self.write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.2.0\n\n- Old.\n")
        self.assert_check_fails("## Unreleased")

    # AC1 b
    def test_heading_that_is_not_plain_fails(self):
        # The mistyped forms must not fall through to the older '## 0.2.0' section.
        for heading in ("## 0.3.0-beta.1", "## v0.3.0", "## 0.3.0 (2026-11-20)", "## 01.2.3", "##  0.3.0",
                        "##\t0.3.0", "  ## 0.3.0", "### 0.3.0", "##0.3.0"):
            with self.subTest(heading=heading):
                self.write("CHANGELOG.md", f"# Changelog\n\n{heading}\n\n- New.\n\n## 0.2.0\n\n- Old.\n")
                self.assert_check_fails("not a plain '## X.Y.Z'")

    # AC1 c
    def test_missing_changelog_or_heading_fails(self):
        self.write("CHANGELOG.md", "# Changelog\n\n- New.\n")
        self.assert_check_fails("no '## ' heading")
        (self.root / "CHANGELOG.md").unlink()
        self.assert_check_fails("CHANGELOG.md is missing")

    # AC1 d
    def test_empty_section_fails(self):
        self.write("CHANGELOG.md", "# Changelog\n\n## 0.3.0\n\n  \n## 0.2.0\n\n- Old.\n")
        self.assert_check_fails("section '## 0.3.0' is empty")

    def test_empty_section_still_checks_the_tag(self):
        self.write("CHANGELOG.md", "# Changelog\n\n## 0.3.0\n\n## 0.2.0\n\n- Old.\n")
        self.tag("v0.3.0")
        self.assert_check_fails("section '## 0.3.0' is empty", "tag v0.3.0 already exists on origin")

    # AC1 e: every listed field, and every problem in one run.
    def test_prerelease_versions_fail_naming_file_and_field(self):
        self.write_json("plugins/a/.claude-plugin/plugin.json", {"version": "0.3.0-beta.1"})
        self.write_json("plugins/a/.codex-plugin/plugin.json", {"version": 3})
        self.write_json("plugins/a/package.json", {"version": "0.3.0+build"})
        self.write_json("plugins/a/package-lock.json", {"version": "0.3.0", "packages": {"": {"version": "0.3.0-beta.1"}}})
        self.write_json("plugins/b/package-lock.json", {"version": "0.3.0-beta.1", "packages": {"": {"version": "0.3.0"}}})
        self.write_json(".claude-plugin/marketplace.json", {
            "version": "1.0.0-rc.1", "metadata": {"version": "0.3"},
            "plugins": [{"name": "a", "version": "0.3.0"}, {"name": "b", "version": "0.3.0-beta.2"}],
        })
        self.assert_check_fails(
            "plugins/a/.claude-plugin/plugin.json: version is '0.3.0-beta.1'",
            "plugins/a/.codex-plugin/plugin.json: version is 3",
            "plugins/a/package.json: version is '0.3.0+build'",
            "plugins/a/package-lock.json: packages[\"\"].version is '0.3.0-beta.1'",
            "plugins/b/package-lock.json: version is '0.3.0-beta.1'",
            ".claude-plugin/marketplace.json: version is '1.0.0-rc.1'",
            ".claude-plugin/marketplace.json: metadata.version is '0.3'",
            ".claude-plugin/marketplace.json: plugins[1].version is '0.3.0-beta.2'",
        )

    def test_untracked_manifests_are_ignored(self):
        path = self.root / ".claude/worktrees/x/plugins/a/.claude-plugin/plugin.json"
        path.parent.mkdir(parents=True)
        path.write_text('{"version": "0.3.0-beta.1"}', encoding="utf-8")
        self.assertEqual(self.run_cli("check")[:2], (0, "v0.3.0\n"))

    # AC1 f
    def test_invalid_json_fails(self):
        for text in ("{", '{"version": "0.2.1", "x": NaN}', '{"version": "0.2.1", "x": -Infinity}'):
            with self.subTest(text=text):
                self.write("plugins/a/.claude-plugin/plugin.json", text)
                self.assert_check_fails("plugins/a/.claude-plugin/plugin.json: not valid JSON")

    # AC1 g
    def test_existing_tag_fails(self):
        self.tag("v0.3.0")
        self.assert_check_fails("tag v0.3.0 already exists on origin")

    def test_similar_tag_is_not_the_release_tag(self):
        self.tag("x/refs/tags/v0.3.0")
        self.assertEqual(self.run_cli("check")[:2], (0, "v0.3.0\n"))

    def test_unreachable_origin_fails(self):
        git(self.root, "remote", "set-url", "origin", str(self.root / "missing.git"))
        self.assert_check_fails("could not list the tags on origin")

    # AC2 a
    def test_publish_prints_tag_and_writes_notes(self):
        self.write("CHANGELOG.md", "# Changelog\n\n## 0.3.0\n\n### Added\n\n- A change.\n\n## 0.2.0\n\n- Older.\n")
        notes = self.root.parent / "notes.md"
        self.assertEqual(self.run_cli("publish", "--notes-file", str(notes))[:2], (0, "v0.3.0\n"))
        self.assertEqual(notes.read_text(encoding="utf-8"), "### Added\n\n- A change.\n")

    # AC2 b
    def test_publish_with_existing_tag_changes_nothing(self):
        self.tag("v0.3.0")
        notes = self.root.parent / "notes.md"
        code, out, err = self.run_cli("publish", "--notes-file", str(notes))
        self.assertEqual((code, out), (0, ""))
        self.assertIn("nothing to publish", err)
        self.assertFalse(notes.exists())

    # AC2 c
    def test_publish_on_unreleasable_tree_fails(self):
        self.write_json("plugins/a/.claude-plugin/plugin.json", {"version": "0.3.0-beta.1"})
        notes = self.root.parent / "notes.md"
        code, out, _ = self.run_cli("publish", "--notes-file", str(notes))
        self.assertEqual((code, out), (1, ""))
        self.assertFalse(notes.exists())


if __name__ == "__main__":
    unittest.main()
