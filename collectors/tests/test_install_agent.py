"""The gather agent is rendered from the config: only the chosen providers, only their tools."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("install_agent", Path(__file__).parents[2] / "scripts" / "install_agent.py")
assert spec and spec.loader
install_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_agent)

BASE = {"me": "Alex Example", "ledger_dir": "~/daybook-ledger",
        "providers": {"code": {"type": "github"}, "tickets": {"type": "jira"}}}


def test_teams_and_outlook_render_with_exactly_their_tools():
    cfg = {**BASE, "providers": {**BASE["providers"],
           "chat": {"type": "teams", "tools": ["mcp__x__chat_message_search"], "search_terms": "PROJ"},
           "mail": {"type": "outlook", "tools": ["mcp__x__outlook_calendar_search"]}}}
    text = install_agent.render(cfg, "~/c.json")
    assert "tools: Bash, Read, mcp__x__chat_message_search, mcp__x__outlook_calendar_search\n" in text
    assert 'query: "PROJ OR <each PR number>"' in text
    assert "from GitHub, git, Jira, Teams and Outlook" in text
    assert "{{" not in text


def test_no_chat_or_mail_leaves_only_bash_and_read():
    cfg = {**BASE, "providers": {**BASE["providers"], "chat": {"type": "none"}, "mail": {"type": "none"}}}
    text = install_agent.render(cfg, "~/c.json")
    assert "tools: Bash, Read\n" in text
    assert "Chat: not configured" in text and "Mail: not configured" in text


def test_a_provider_without_an_agent_section_is_refused_by_name():
    cfg = {**BASE, "providers": {**BASE["providers"], "chat": {"type": "slack"}}}
    with pytest.raises(SystemExit, match="slack"):
        install_agent.render(cfg, "~/c.json")
