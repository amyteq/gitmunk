"""The dispatch reaction: which call each event makes, the variable, and that it never blocks a run."""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import agent_lib  # noqa: E402
import react  # noqa: E402
from agent_lib import REACTIONS, AgentConfig, credential_shaped_variables  # noqa: E402
from normalize_event import extract, extract_dispatch  # noqa: E402
from test_security import gate_stops  # noqa: E402

REPO = "example-org/example-repo"
WORKFLOW = (Path(HERE).parents[2] / ".github/workflows/ask-agent.yml").read_text()


def job(name: str) -> str:
    start = WORKFLOW.index(f"\n  {name}:\n")
    following = re.search(r"\n  [a-z-]+:\n", WORKFLOW[start + 1:])
    return WORKFLOW[start:start + 1 + following.start()] if following else WORKFLOW[start:]


def calls(context: dict, content: str) -> list[tuple]:
    """Run react() with both API helpers recorded."""
    made: list[tuple] = []
    with patch.object(react, "gh_rest", side_effect=lambda path, **kw: made.append(("rest", path, kw))), \
         patch.object(react, "gh_graphql", side_effect=lambda query, variables: made.append(("graphql", variables))):
        react.react(context, content)
    return made


def routed(payload: dict, event_name: str, agent: str = "claude") -> dict:
    context = extract(payload, event_name, AgentConfig(agent, {}))
    context["repo"] = REPO
    return context


class EventTargets(unittest.TestCase):
    """AC1: one reaction call per event, on the endpoint for that event."""

    def test_each_event_reacts_on_its_triggering_text(self):
        body = {"body": "@claude explain"}
        cases = [
            ("issue_comment", {"action": "created", "issue": {"number": 7}, "comment": {"id": 11, **body}},
             ("rest", f"repos/{REPO}/issues/comments/11/reactions")),
            ("issue_comment", {"action": "created", "issue": {"number": 8, "pull_request": {}}, "comment": {"id": 12, **body}},
             ("rest", f"repos/{REPO}/issues/comments/12/reactions")),
            ("pull_request_review_comment", {"action": "created", "pull_request": {"number": 9}, "comment": {"id": 13, **body}},
             ("rest", f"repos/{REPO}/pulls/comments/13/reactions")),
            ("pull_request_review", {"action": "submitted", "pull_request": {"number": 10}, "review": body},
             ("rest", f"repos/{REPO}/issues/10/reactions")),
            ("issues", {"action": "opened", "issue": {"number": 14, "title": "t", **body}},
             ("rest", f"repos/{REPO}/issues/14/reactions")),
            ("pull_request_target", {"action": "opened", "pull_request": {"number": 15, "title": "t", **body}},
             ("rest", f"repos/{REPO}/issues/15/reactions")),
            ("pull_request", {"action": "edited", "changes": {"body": {"from": "old"}},
                              "pull_request": {"number": 16, "title": "t", **body}},
             ("rest", f"repos/{REPO}/issues/16/reactions")),
        ]
        for event_name, payload, (api, path) in cases:
            with self.subTest(event=event_name, path=path):
                self.assertEqual(calls(routed(payload, event_name), "rocket"), [(api, path, {"method": "POST", "body": {"content": "rocket"}})])

    def test_discussions_react_through_graphql(self):
        comment = routed({"action": "created", "discussion": {"number": 3, "node_id": "D_3"},
                          "comment": {"node_id": "DC_9", "body": "@codex explain"}}, "discussion_comment", "codex")
        discussion = routed({"action": "created", "discussion": {"number": 3, "node_id": "D_3", "title": "t",
                                                                 "body": "@codex explain"}}, "discussion", "codex")
        self.assertEqual(calls(comment, "eyes"), [("graphql", {"subjectId": "DC_9", "content": "EYES"})])
        self.assertEqual(calls(discussion, "+1"), [("graphql", {"subjectId": "D_3", "content": "THUMBS_UP"})])
        self.assertEqual(calls(discussion, "-1"), [("graphql", {"subjectId": "D_3", "content": "THUMBS_DOWN"})])

    def test_a_manual_run_makes_no_call(self):
        context = extract_dispatch(AgentConfig("claude", {}), {"inputs": {"surface": "issue", "number": "4", "request": "explain"}})
        context["repo"] = REPO
        self.assertEqual(calls(context, "rocket"), [])


class Variable(unittest.TestCase):
    """AC2: `<AGENT>_ACTION_REACTION` over the eight names GitHub accepts."""

    def choose(self, agent: str, value: str | None) -> tuple[str, str]:
        variables = {} if value is None else {f"{agent.upper()}_ACTION_REACTION": value}
        out = io.StringIO()
        with redirect_stdout(out):
            chosen = react.reaction(AgentConfig(agent, variables))
        return chosen, out.getvalue()

    def test_unset_or_empty_uses_the_agent_default(self):
        for value in (None, ""):
            self.assertEqual(self.choose("claude", value), ("rocket", ""))
            self.assertEqual(self.choose("codex", value), ("eyes", ""))

    def test_every_accepted_name_in_any_case_with_trailing_whitespace(self):
        self.assertEqual(REACTIONS, ("+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"))
        for name in REACTIONS:
            for value in (name, name.upper(), f"{name.upper()} "):
                variables = {"CODEX_ACTION_REACTION": value}
                self.assertFalse(gate_stops(variables) or credential_shaped_variables(variables), value)
                self.assertEqual(self.choose("codex", value), (name, ""))

    def test_leading_whitespace_stops_at_the_credential_gate_like_every_variable(self):
        # F001 round 1: the existing gate refuses a leading space in any Ask variable, so AC2 revision 2 stops here too.
        for agent in ("claude", "codex"):
            for value in (" ", " eyes", " ROCKET ", "\teyes"):
                variables = {f"{agent.upper()}_ACTION_REACTION": value}
                self.assertTrue(gate_stops(variables), (agent, value))
            self.assertTrue(credential_shaped_variables({f"{agent.upper()}_ACTION_REACTION": " eyes"}))
        # F001 round 2: the gate rejects only a leading space or control character; other Unicode spaces pass it and are trimmed.
        variables = {"CODEX_ACTION_REACTION": " EYES"}
        self.assertFalse(gate_stops(variables) or credential_shaped_variables(variables))
        self.assertEqual(self.choose("codex", " EYES"), ("eyes", ""))

    def test_any_other_value_warns_and_uses_the_default(self):
        for agent, default in (("claude", "rocket"), ("codex", "eyes")):
            for value in ("🚀", "party", "thumbs_up", "rocket!"):
                chosen, printed = self.choose(agent, value)
                self.assertEqual(chosen, default)
                self.assertEqual(printed.count("::warning::"), 1)
                self.assertIn(f"{agent.upper()}_ACTION_REACTION", printed)
                self.assertIn(", ".join(REACTIONS), printed)


class NeverBlocks(unittest.TestCase):
    """AC3: a failed reaction is one warning and exit code 0."""

    def run_main(self, context: dict, rest=None, graphql=None) -> tuple[int, str, int]:
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder, "event.json")
            event.write_text(json.dumps({"repo": REPO, "config": {}, **context}))
            out = io.StringIO()
            with patch.dict(os.environ, {"AGENT": "claude", "EVENT_FILE": str(event)}, clear=True), \
                 patch.object(react, "gh_rest", side_effect=rest) as rest_mock, \
                 patch.object(react, "gh_graphql", side_effect=graphql) as graphql_mock, redirect_stdout(out):
                code = react.main()
        return code, out.getvalue(), rest_mock.call_count + graphql_mock.call_count

    def test_api_failures_warn_and_exit_zero(self):
        for context, rest, graphql in (
            ({"react": {"kind": "issue_comment", "id": 1}}, RuntimeError("HTTP Error 403"), None),
            ({"react": {"kind": "node", "node_id": "DC_1"}}, None, RuntimeError("GraphQL error: [...]")),
        ):
            code, printed, made = self.run_main(context, rest, graphql)
            self.assertEqual((code, printed.count("::warning::"), made), (0, 1, 1))

    def test_a_graphql_errors_response_warns_and_exits_zero(self):
        # F002 round 1: the real gh_graphql turns an `errors` response into the warning, not a mocked exception.
        with tempfile.TemporaryDirectory() as folder:
            event = Path(folder, "event.json")
            event.write_text(json.dumps({"repo": REPO, "config": {}, "react": {"kind": "node", "node_id": "DC_1"}}))
            out = io.StringIO()
            with patch.dict(os.environ, {"AGENT": "claude", "EVENT_FILE": str(event)}, clear=True), \
                 patch.object(agent_lib, "gh_rest", return_value={"errors": [{"message": "Resource not accessible"}]}) as rest, \
                 redirect_stdout(out):
                self.assertEqual(react.main(), 0)
        self.assertEqual(rest.call_count, 1)
        self.assertEqual(out.getvalue().count("::warning::"), 1)
        self.assertIn("Resource not accessible", out.getvalue())
        self.assertNotIn("reacted with", out.getvalue())

    def test_a_missing_target_warns_without_a_call(self):
        for target in ({"kind": "issue_comment", "id": None}, {"kind": "issue"}, {"kind": "node", "node_id": ""}, {}):
            code, printed, made = self.run_main({"react": target})
            self.assertEqual((code, printed.count("::warning::"), made), (0, 1, 0), target)

    def test_a_missing_request_file_warns_and_exits_zero(self):
        out = io.StringIO()
        with patch.dict(os.environ, {"AGENT": "claude", "EVENT_FILE": "/nonexistent/event.json"}, clear=True), redirect_stdout(out):
            self.assertEqual(react.main(), 0)
        self.assertEqual(out.getvalue().count("::warning::"), 1)

    def test_success_logs_the_reaction(self):
        code, printed, made = self.run_main({"react": {"kind": "issue", "id": 5}}, rest=lambda *a, **k: {})
        self.assertEqual((code, made), (0, 1))
        self.assertIn("reacted with rocket", printed)


class WorkflowJob(unittest.TestCase):
    """AC3 and AC4: the reaction job's place, token and variables in ask-agent.yml."""

    def test_the_job_runs_only_when_authorized_and_nothing_waits_for_it(self):
        job_text = job("react")
        self.assertIn("    needs: prepare\n", job_text)
        self.assertIn("    if: needs.prepare.outputs.authorized == 'true'\n", job_text)
        self.assertIn("    continue-on-error: true\n", job_text)
        self.assertIn('run: python3 "$TOOLS/react.py"', job_text)
        self.assertNotIn("secrets.", job_text)
        self.assertNotIn("vars.", job_text)
        self.assertIn("    needs: prepare\n", job("execute"))
        self.assertIn("    needs: [prepare, execute]\n", job("publish"))

    def test_token_permissions(self):
        def permissions(name: str) -> list[str]:
            block = re.search(r"\n    permissions:\n((?:      .*\n)+)", job(name)).group(1)
            return sorted(line.strip() for line in block.splitlines())

        self.assertEqual(permissions("react"), ["contents: read", "discussions: write", "issues: write", "pull-requests: write"])
        self.assertEqual(permissions("prepare"), ["contents: read", "discussions: read", "issues: read", "pull-requests: read"])
        self.assertEqual(permissions("execute"), ["contents: read"])

    def test_both_variables_reach_routing_and_the_credential_gate(self):
        for name in ("CLAUDE_ACTION_REACTION", "CODEX_ACTION_REACTION"):
            self.assertIn(f"          {name}: ${{{{ vars.{name} }}}}\n", WORKFLOW)
            # Once in each of the gate's two `sk-` / `sk_live` lists; test_security checks their order against routing.
            self.assertEqual(WORKFLOW.count(f"vars.{name},") + WORKFLOW.count(f"vars.{name})"), 2)

    def test_the_caller_templates_already_grant_the_reaction_permissions(self):
        for agent in ("claude", "codex"):
            template = (Path(HERE).parents[2] / f"templates/github/ask-{agent}.yml").read_text()
            self.assertIn("permissions: { contents: write, pull-requests: write, issues: write, discussions: write }", template)


if __name__ == "__main__":
    unittest.main()
