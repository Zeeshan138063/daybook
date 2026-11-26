"""The Scrum card's Jira moves: a dry run writes nothing, a move writes the transition and the date,
a move Jira doesn't offer fails clearly, and the open-tickets list includes planned tickets."""

import json
from datetime import date

from daybook_collect import scrum
from daybook_collect.contract import Context
from daybook_collect.tickets.jira import JiraTickets

CFG = {"ledger_dir": "/tmp", "providers": {"tickets": {"type": "jira", "start_date_field": "customfield_1"}}}
DAY = "2026-01-15"
TRANSITIONS = [
    {"id": "71", "name": "Start Development", "to": {"name": "In Development"}},
    {"id": "81", "name": "Submit for Review", "to": {"name": "In Review"}},
]


class FakeJira:
    def __init__(self, status="Backlog", start=None, due=None, transitions=TRANSITIONS):
        self.status, self.start, self.due, self.transitions = status, start, due, transitions
        self.writes: list[tuple[str, str, dict]] = []

    def request(self, method, path, json=None, params=None):
        if method == "GET" and path.endswith("/transitions"):
            return {"transitions": self.transitions}
        if method == "GET" and path.startswith("issue/"):
            return {"fields": {"status": {"name": self.status}, "duedate": self.due, "customfield_1": self.start}}
        if method == "POST" and path.endswith("/transitions"):
            self.writes.append((method, path, json))
            self.status = next(t["to"]["name"] for t in self.transitions if t["id"] == json["transition"]["id"])
            return {}
        if method == "PUT":
            self.writes.append((method, path, json))
            return {}
        raise AssertionError((method, path))


def test_a_dry_run_says_what_would_change_and_writes_nothing():
    jira = FakeJira()
    out = scrum.move(jira, CFG, "PROJ-7", "start", DAY, dry_run=True)
    assert out["error"] is None
    assert (out["from"], out["to"], out["transition"]["name"]) == ("Backlog", "In Development", "Start Development")
    assert out["fields"] == {"Start date": [None, DAY]}
    assert out["wrote"] is False and jira.writes == []


def test_start_writes_the_transition_and_an_empty_start_date_only():
    jira = FakeJira()
    out = scrum.move(jira, CFG, "PROJ-7", "start", DAY, dry_run=False)
    assert out["wrote"] is True and out["to"] == "In Development"
    assert jira.writes == [
        ("POST", "issue/PROJ-7/transitions", {"transition": {"id": "71"}}),
        ("PUT", "issue/PROJ-7", {"fields": {"customfield_1": DAY}}),
    ]
    kept = FakeJira(start="2026-01-10")
    out = scrum.move(kept, CFG, "PROJ-7", "start", DAY, dry_run=False)
    assert out["fields"] == {} and [w[0] for w in kept.writes] == ["POST"]


def test_done_moves_to_in_review_and_sets_the_due_date():
    jira = FakeJira(status="In Development", due="2026-01-01")
    out = scrum.move(jira, CFG, "PROJ-7", "done", DAY, dry_run=False)
    assert out["to"] == "In Review"
    assert out["fields"] == {"Due date": ["2026-01-01", DAY]}
    assert jira.writes[-1] == ("PUT", "issue/PROJ-7", {"fields": {"duedate": DAY}})


def test_a_move_from_the_wrong_status_or_without_a_transition_fails_and_writes_nothing():
    wrong = FakeJira(status="In Review")
    out = scrum.move(wrong, CFG, "PROJ-7", "done", DAY, dry_run=False)
    assert "PROJ-7 is In Review" in out["error"] and wrong.writes == []
    closed = FakeJira(status="Backlog", transitions=[])
    out = scrum.move(closed, CFG, "PROJ-7", "start", DAY, dry_run=False)
    assert "no transition" in out["error"] and closed.writes == []


def test_a_write_is_logged_and_printed(tmp_path, capsys, monkeypatch):
    cfg = {**CFG, "ledger_dir": str(tmp_path)}
    monkeypatch.setattr(scrum, "load_config", lambda: cfg)
    assert scrum.main(["move", "proj-7", "--to", "start", "--day", DAY], client=FakeJira()) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["key"] == "PROJ-7" and printed["wrote"] is True
    logged = json.loads((tmp_path / "moves.log").read_text().splitlines()[0])
    assert (logged["key"], logged["move"], logged["to"]) == ("PROJ-7", "start", "In Development")
    assert scrum.main(["move", "PROJ-7", "--to", "start", "--dry-run", "--day", DAY], client=FakeJira()) == 0
    assert len((tmp_path / "moves.log").read_text().splitlines()) == 1


class SearchJira:
    def __init__(self):
        self.jqls: list[str] = []

    def request(self, method, path, json=None, params=None):
        self.jqls.append(json["jql"])
        key = "PROJ-9" if "key in" in json["jql"] else "PROJ-1"
        return {"issues": [{"key": key, "fields": {
            "summary": "x", "status": {"name": "Done" if key == "PROJ-9" else "Backlog"},
            "duedate": None, "customfield_1": None, "updated": "2026-01-15", "assignee": None}}]}


def test_mine_lists_open_tickets_and_the_last_weeks_planned_ones(tmp_path):
    (tmp_path / "scrum.json").write_text(json.dumps({"days": {
        "2026-01-14": {"items": [{"key": "PROJ-9"}, {"key": "PROJ-1"}]},
        "2025-12-01": {"items": [{"key": "PROJ-5"}]},
    }}))
    ctx = Context(cfg={**CFG, "ledger_dir": str(tmp_path)}, day=date(2026, 1, 15))
    jira = SearchJira()
    rows = JiraTickets.mine(jira, ctx, ["summary"])
    assert [(r["key"], r["status"]) for r in rows] == [("PROJ-1", "Backlog"), ("PROJ-9", "Done")]
    assert jira.jqls[1] == "key in (PROJ-9)"


class OrderJira:
    def __init__(self, fail_custom=False):
        self.fail_custom = fail_custom

    def request(self, method, path, json=None, params=None):
        if "Rank" in json["jql"]:
            return {"issues": [{"key": "PROJ-5"}, {"key": "PROJ-2"}]}
        if self.fail_custom:
            raise RuntimeError("400 Bad Request: bad JQL")
        return {"issues": [{"key": "PROJ-9"}]}


def test_orders_reads_the_board_rank_and_the_custom_search(tmp_path):
    (tmp_path / "scrum.json").write_text(json.dumps({"days": {}, "settings": {"custom_jql": "project = PROJ"}}))
    ctx = Context(cfg={**CFG, "ledger_dir": str(tmp_path)}, day=date(2026, 1, 15))
    out = JiraTickets.orders(OrderJira(), ctx)
    assert out == {"orders": {"board": ["PROJ-5", "PROJ-2"], "custom": ["PROJ-9"]}, "order_errors": {}}


def test_a_bad_custom_search_is_recorded_and_the_board_order_still_comes(tmp_path):
    (tmp_path / "scrum.json").write_text(json.dumps({"days": {}, "settings": {"custom_jql": "nonsense"}}))
    ctx = Context(cfg={**CFG, "ledger_dir": str(tmp_path)}, day=date(2026, 1, 15))
    out = JiraTickets.orders(OrderJira(fail_custom=True), ctx)
    assert out["orders"] == {"board": ["PROJ-5", "PROJ-2"]}
    assert "bad JQL" in out["order_errors"]["custom"]


def test_without_a_custom_search_only_the_board_order_is_read(tmp_path):
    ctx = Context(cfg={**CFG, "ledger_dir": str(tmp_path)}, day=date(2026, 1, 15))
    assert JiraTickets.orders(OrderJira(), ctx)["orders"] == {"board": ["PROJ-5", "PROJ-2"]}
