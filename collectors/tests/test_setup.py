"""Setup: answers in, a config that passes the schema out; secrets are never asked for."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("setup_script", ROOT / "scripts" / "setup.py")
assert spec and spec.loader
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def repo(tmp: Path, remote: str) -> str:
    subprocess.run(["git", "init", "-q", str(tmp)], check=True)
    subprocess.run(["git", "-C", str(tmp), "remote", "add", "origin", remote], check=True)
    return str(tmp)


def test_answers_become_a_config_with_repos_from_their_remotes(tmp_path):
    a = {"name": "Alex Example", "reviewer": "Sam Reviewer",
         "repos": [repo(tmp_path / "app", "git@github.com:example/app.git"),
                   repo(tmp_path / "web", "https://github.com/example/web")],
         "tickets": "jira", "jira_site": "example.atlassian.net", "jira_project": "PROJ",
         "chat": "slack", "chat_tools": ["mcp__s__search"], "mail": "none",
         "day_min": "7h 30m", "day_max": "8:30"}
    cfg = setup.build(a)
    assert cfg["call_me"] == "Alex" and cfg["watch_people"] == ["Sam Reviewer"]
    assert set(cfg["providers"]["code"]["repos"]) == {"example/app", "example/web"}
    assert cfg["providers"]["tickets"]["site"] == "https://example.atlassian.net"
    assert cfg["providers"]["chat"] == {"type": "slack", "via": "connector", "tools": ["mcp__s__search"]}
    assert (cfg["day_min_minutes"], cfg["day_max_minutes"]) == (450, 510)
    assert "token" not in json.dumps(cfg)


def test_the_config_passes_the_schema(tmp_path):
    jsonschema = pytest.importorskip("jsonschema")
    cfg = setup.build({"name": "Alex Example", "tickets": "none", "chat": "teams", "mail": "outlook"})
    jsonschema.validate(cfg, json.loads((ROOT / "schema" / "config.schema.json").read_text()))


def test_a_token_is_named_by_where_it_lives_never_its_value():
    cfg = setup.build({"name": "Alex Example", "tickets": "jira", "jira_site": "https://x.atlassian.net",
                       "jira_token_env": "JIRA_API_TOKEN"})
    assert cfg["providers"]["tickets"]["token"] == {"env": "JIRA_API_TOKEN"}


@pytest.mark.parametrize("text,want", [("8h 15m", 495), ("8h", 480), ("8:15", 495), ("8.25", 495), (495, 495)])
def test_durations(text, want):
    assert setup.minutes(text) == want


def test_bad_answers_are_refused_by_name():
    with pytest.raises(ValueError, match="chat"):
        setup.build({"name": "A", "chat": "irc"})
    with pytest.raises(ValueError, match="minimum"):
        setup.build({"name": "A", "day_min": "9h", "day_max": "8h"})
