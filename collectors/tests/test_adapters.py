"""Adapters against recorded answers: no network, no sign-in."""

from __future__ import annotations

import json
from datetime import date

from daybook_collect.code.github import GitHubCode
from daybook_collect.contract import Context, provider
from daybook_collect.gather import gather
from daybook_collect.tickets.jira import JiraTickets, area_of

DAY = date(2026, 1, 15)
CFG = {
    "ledger_dir": "/tmp/x", "day_min_minutes": 450, "day_max_minutes": 510,
    "providers": {
        "code": {"type": "github", "repos": {"acme/api": ""}},
        "tickets": {"type": "jira", "site": "https://example.atlassian.net", "start_date_field": "customfield_1",
                    "board": {"jql": "project = PROJ", "areas": {"frontend": ["UI"]}, "default_area": "backend"}},
    },
}


def gh_runner(argv: list[str], cwd: str | None) -> str:
    if argv[:3] == ["gh", "api", "user"]:
        return "alex\n"
    if argv[:3] == ["gh", "pr", "list"]:
        return json.dumps([{"number": 7, "title": "PROJ-1, PROJ-2: notes", "url": "https://github.com/acme/api/pull/7",
                            "state": "OPEN", "mergedAt": None, "reviewDecision": ""}])
    if argv[:3] == ["gh", "pr", "view"]:
        return json.dumps({
            "commits": [{"messageHeadline": "PROJ-3: tests"}, {"messageHeadline": "tidy"}],
            "reviews": [{"author": {"login": "sam"}, "state": "COMMENTED", "submittedAt": "2026-01-15T10:00:00Z"}],
            "comments": [{"author": {"login": "sam"}, "createdAt": "2026-01-15T10:01:00Z", "body": "x" * 500}],
        })
    if argv[:2] == ["gh", "api"]:
        return json.dumps([{"user": {"login": "sam"}, "created_at": "2026-01-15T10:02:00Z", "path": "a.py", "line": 3,
                            "body": "nit"}])
    raise AssertionError(argv)


def test_github_turns_prs_into_the_v1_section():
    out = GitHubCode().gather(Context(cfg=CFG, day=DAY, run=gh_runner))
    assert out["login"] == "alex"
    pr = out["prs"][0]
    assert pr["tickets"] == ["PROJ-1", "PROJ-2", "PROJ-3"]
    assert pr["commits_by_ticket"] == {"PROJ-3": ["PROJ-3: tests"], "other": ["tidy"]}
    assert pr["reviews"] == [{"by": "sam", "state": "COMMENTED", "at": "2026-01-15T10:00:00Z"}]
    assert len(pr["comments"][0]["text"]) == 400
    assert pr["inline_comments"][0]["path"] == "a.py"


class FakeJira:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def request(self, method, path, json=None, params=None):
        self.calls.append((method, path))
        if path == "myself":
            return {"accountId": "me"}
        if path == "search/jql":
            jql = json["jql"]
            issue = {"key": "PROJ-1", "fields": {"summary": "Note editor", "status": {"name": "In Review"},
                     "updated": "2026-01-15", "duedate": None, "customfield_1": "2026-01-15",
                     "parent": {"key": "PROJ-0", "fields": {"summary": "Editor UI screens"}},
                     "issuetype": {"name": "Task"}, "assignee": {"displayName": "Alex Example"}}}
            return {"issues": [issue]} if "PROJ" in jql or "currentUser" in jql else {"issues": []}
        if path.endswith("/worklog"):
            return {"worklogs": [
                {"id": "1", "author": {"accountId": "me"}, "started": "2026-01-15T09:00:00.000+0000", "timeSpentSeconds": 5400},
                {"id": "2", "author": {"accountId": "someone"}, "started": "2026-01-15T09:00:00.000+0000", "timeSpentSeconds": 999},
            ]}
        raise AssertionError(path)


def test_jira_counts_only_my_worklogs_and_reads_the_start_field():
    out = JiraTickets(FakeJira()).gather(Context(cfg=CFG, day=DAY))
    t = out["tickets"][0]
    assert t["start_date"] == "2026-01-15"
    assert [w["seconds"] for w in t["worklogs_today"]] == [5400]
    assert out["logged_today_minutes"] == 90
    assert out["board"][0]["area"] == "frontend"
    assert out["day_range_minutes"] == [450, 510]


def test_area_falls_back_to_the_default():
    assert area_of("Backend services", {"areas": {"frontend": ["UI"]}, "default_area": "backend"}) == "backend"


def test_an_old_config_without_providers_still_works():
    old = {"repos": {"acme/api": "/x"}, "jira_site": "https://example.atlassian.net", "start_date_field": "customfield_9"}
    assert provider(old, "code") == {"type": "github", "repos": {"acme/api": "/x"}}
    assert provider(old, "tickets")["start_date_field"] == "customfield_9"


class Boom:
    source = "github"

    def gather(self, ctx):
        raise RuntimeError("gh: not signed in")


class Empty:
    def __init__(self, source):
        self.source = source

    def gather(self, ctx):
        return {"commits": []} if self.source == "git" else {}


def test_a_failing_source_is_recorded_and_the_rest_still_runs():
    data = gather(CFG, DAY, {}, code=Boom(), git=Empty("git"), tickets=Empty("jira"))
    assert data["sources"]["github"]["ok"] is False
    assert "not signed in" in data["sources"]["github"]["error"]
    assert data["sources"]["jira"]["ok"] is True
    assert data["sources"]["teams"]["ok"] is False  # the agent fills chat later


def test_none_skips_a_category():
    cfg = {**CFG, "providers": {**CFG["providers"], "tickets": {"type": "none"}, "chat": {"type": "none"}}}
    data = gather(cfg, DAY, {}, code=Empty("github"), git=Empty("git"))
    assert "jira" not in data and "jira" not in data["sources"]
    assert "none" not in data["sources"] and "teams" not in data["sources"]


def test_earlier_agent_sections_are_kept():
    data = gather(CFG, DAY, {"teams": {"questions": [1]}, "tests": {"source": "PR"}},
                  code=Empty("github"), git=Empty("git"), tickets=Empty("jira"))
    assert data["teams"] == {"questions": [1]} and data["tests"] == {"source": "PR"}
