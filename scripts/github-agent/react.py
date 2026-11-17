#!/usr/bin/env python3
"""React on the text that triggered an authorized run, so the requester sees it was picked up.

The reaction is `<AGENT>_ACTION_REACTION` (Claude `rocket`, Codex `eyes` by default).
It is a courtesy: every failure is a warning and the script always exits 0, and the
workflow runs it in its own job that nothing waits for.
"""

from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from agent_lib import (  # noqa: E402
    AGENT_DEFAULTS,
    REACTIONS,
    AgentConfig,
    gh_graphql,
    gh_rest,
    load_config,
    load_context,
    log,
    warn,
)

ADD_REACTION = """
mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: {subjectId: $subjectId, content: $content}) { reaction { content } }
}
"""

# GraphQL spells two REST names differently; the others are the upper-case name.
GRAPHQL_CONTENT = {"+1": "THUMBS_UP", "-1": "THUMBS_DOWN"}

# `react.kind` recorded by normalize_event.py -> REST path segment before `/<id>/reactions`.
REST_TARGETS = {"issue_comment": "issues/comments", "pr_review_comment": "pulls/comments", "issue": "issues"}


def reaction(config: AgentConfig) -> str:
    """The configured reaction, or the agent's default with a warning when GitHub would not accept it."""
    value = config.get("REACTION").lower()
    if value in REACTIONS:
        return value
    default = AGENT_DEFAULTS[config.agent]["REACTION"]
    warn(f"{config.prefix}REACTION must be one of {', '.join(REACTIONS)}; using {default}")
    return default


def react(context: dict[str, Any], content: str) -> bool:
    """Add `content` to the `react` target routing recorded. False when there is none (manual runs)."""
    target = context.get("react") or {}
    kind = target.get("kind")
    if kind == "none":
        return False
    if kind == "node":
        if not target.get("node_id"):
            raise ValueError("no node ID to react on")
        gh_graphql(ADD_REACTION, {"subjectId": target["node_id"], "content": GRAPHQL_CONTENT.get(content, content.upper())})
        return True
    if kind not in REST_TARGETS or not target.get("id"):
        raise ValueError(f"no reaction target in {target!r}")
    gh_rest(f"repos/{context['repo']}/{REST_TARGETS[kind]}/{target['id']}/reactions", method="POST", body={"content": content})
    return True


def main() -> int:
    try:
        content = reaction(load_config())
        if react(load_context(), content):
            log(f"reacted with {content}")
    except Exception as error:  # noqa: BLE001
        warn(f"could not add the reaction ({error}); the run continues without it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
