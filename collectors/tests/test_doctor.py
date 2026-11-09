"""The doctor: a tick or the exact fix, for each tool, without touching any service."""

from __future__ import annotations

import json
from pathlib import Path

from daybook_collect import doctor as D


def write(tmp: Path, cfg: dict) -> Path:
    path = tmp / "config.json"
    path.write_text(json.dumps(cfg))
    return path


def base(tmp: Path, **extra) -> dict:
    (tmp / "ledger").mkdir(exist_ok=True)
    return {"me": "Alex Example", "ledger_dir": str(tmp / "ledger"), "day_min_minutes": 495,
            "day_max_minutes": 540, **extra}


class Client:
    def __init__(self, fail: bool = False):
        self.fail = fail

    def request(self, method: str, path: str, **_):
        if self.fail:
            raise RuntimeError("401 Unauthorized")
        return {"displayName": "Alex Example"}


def test_no_config_says_run_setup(tmp_path):
    checks = D.run_all(tmp_path / "missing.json")
    assert [(c.ok, c.fix) for c in checks] == [(False, "run /daybook-setup")]


def test_broken_json_names_the_line(tmp_path):
    p = tmp_path / "config.json"
    p.write_text('{"me": "x",\n oops}')
    (c,) = D.run_all(p)
    assert not c.ok and "line 2" in c.what


def test_gh_signed_out_gives_the_login_command(tmp_path, monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: f"/usr/bin/{name}")
    cfg = base(tmp_path, providers={"code": {"type": "github"}, "tickets": {"type": "none"}})
    checks = D.run_all(write(tmp_path, cfg), probe=lambda argv: (1, "You are not logged into any GitHub hosts"))
    gh = next(c for c in checks if c.area == "code")
    assert not gh.ok and gh.fix == "gh auth login"


def test_jira_signed_in_and_signed_out(tmp_path, monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: f"/usr/bin/{name}")
    cfg = base(tmp_path, providers={"code": {"type": "github"},
                                    "tickets": {"type": "jira", "site": "https://example.atlassian.net"}})
    path = write(tmp_path, cfg)
    ok = D.run_all(path, probe=lambda a: (0, ""), client_factory=lambda: Client())
    assert next(c for c in ok if c.area == "tickets").what.endswith("signed in as Alex Example")
    bad = D.run_all(path, probe=lambda a: (0, ""), client_factory=lambda: Client(fail=True))
    t = next(c for c in bad if c.area == "tickets")
    assert not t.ok and t.fix == "jira-agent auth login"


def test_connector_status_comes_from_the_agents_last_run(tmp_path, monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: f"/usr/bin/{name}")
    agent = tmp_path / "agent.md"
    agent.write_text("tools: Bash, Read, mcp__x__chat_message_search\n")
    monkeypatch.setattr(D, "AGENT_FILE", agent)
    cfg = base(tmp_path, providers={"code": {"type": "github"}, "tickets": {"type": "none"},
                                    "chat": {"type": "teams", "tools": ["mcp__x__chat_message_search"]},
                                    "mail": {"type": "outlook", "tools": ["mcp__x__outlook_calendar_search"]}})
    (tmp_path / "ledger" / "2026-11-09.json").write_text(json.dumps(
        {"sources": {"teams": {"ok": True, "at": "2026-11-09T12:49:00"}}}))
    checks = D.run_all(write(tmp_path, cfg), probe=lambda a: (0, ""))
    chat = next(c for c in checks if c.area == "chat")
    mail = next(c for c in checks if c.area == "mail")
    assert chat.ok and "12:49" in chat.what
    assert not mail.ok and "install_agent" in mail.fix  # the agent lacks the mail tool


def test_a_passing_check_never_shows_a_fix(tmp_path, monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: f"/usr/bin/{name}")
    cfg = base(tmp_path, providers={"code": {"type": "github"}, "tickets": {"type": "none"}})
    checks = D.run_all(write(tmp_path, cfg), probe=lambda a: (0, "Logged in to github.com account alex"))
    assert all(c.fix == "" for c in checks if c.ok)
