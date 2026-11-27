"""The PR tracker: each status from its rule, the stacked chain, the merged window, and the gh
account's token put in place only for the gather."""

import json
import os
from datetime import date

from daybook_collect.code.github import GitHubCode
from daybook_collect.code.tracker import label, person, status
from daybook_collect.contract import Context

ME = "me_work"
HEADS = {"feature/a": "API #10"}


def pr(**kw):
    base = {"number": 11, "baseRefName": "develop", "mergedAt": None, "isDraft": False, "mergeable": "MERGEABLE",
            "reviewDecision": "", "reviewRequests": [], "commits": [{"committedDate": "2026-11-26T10:00:00Z"}],
            "activity": []}
    return {**base, **kw}


def review(by, at, state="COMMENTED"):
    return {"by": by, "at": at, "kind": "review", "state": state}


def comment(by, at, kind="inline"):
    return {"by": by, "at": at, "kind": kind}


def test_merged_and_draft():
    assert status(pr(mergedAt="2026-11-26T11:00:00Z"), ME, HEADS) == ("merged", "")
    assert status(pr(isDraft=True), ME, HEADS)[0] == "draft"


def test_reviewer_comments_after_the_last_push_need_fixes():
    st, note = status(pr(activity=[review("sam-lee_x", "2026-11-27T09:00:00Z"), comment("sam-lee_x", "2026-11-27T09:01:00Z"),
                                   comment("sam-lee_x", "2026-11-27T09:02:00Z")]), ME, HEADS)
    assert st == "needs_fixes"
    assert note == "Sam: 2 comments · 2026-11-27"


def test_a_review_with_no_line_comments_reads_reviewed_or_changes_requested():
    assert status(pr(activity=[review("sam-lee_x", "2026-11-27T09:00:00Z")]), ME, HEADS) == (
        "needs_fixes", "Sam: reviewed · 2026-11-27")
    assert status(pr(activity=[review("sam-lee_x", "2026-11-27T09:00:00Z", "CHANGES_REQUESTED")]), ME, HEADS) == (
        "needs_fixes", "Sam: changes requested · 2026-11-27")


def test_a_push_after_the_comments_is_back_for_review():
    st, note = status(pr(commits=[{"committedDate": "2026-11-27T12:00:00Z"}],
                         activity=[comment("sam-lee_x", "2026-11-27T09:00:00Z")]), ME, HEADS)
    assert (st, note) == ("back_for_review", "pushed after review · 2026-11-27")


def test_my_own_comments_and_bots_never_count():
    st, _ = status(pr(activity=[comment(ME, "2026-11-27T09:00:00Z"), comment("github-actions[bot]", "2026-11-27T09:00:00Z")]),
                   ME, HEADS)
    assert st == "in_review"


def test_conflicts_and_a_stacked_base_are_blocked():
    assert status(pr(mergeable="CONFLICTING"), ME, HEADS) == ("blocked", "conflicts with its base")
    assert status(pr(baseRefName="feature/a"), ME, HEADS) == ("blocked", "waits for API #10")


def test_approved_and_in_review():
    assert status(pr(reviewDecision="APPROVED"), ME, HEADS) == ("approved", "ready to merge")
    assert status(pr(reviewRequests=["sam-lee_x"]), ME, HEADS) == ("in_review", "asked Sam")
    assert status(pr(), ME, HEADS) == ("in_review", "no reviewer asked yet")


def test_needs_fixes_wins_over_a_stacked_base():
    st, _ = status(pr(baseRefName="feature/a", activity=[comment("sam-lee_x", "2026-11-27T09:00:00Z")]), ME, HEADS)
    assert st == "needs_fixes"


def test_labels_and_people():
    assert label("Org/notes-api") == "API"
    assert label("Org/notes-web") == "WEB"
    assert label("Org/reflex") == "reflex"
    assert label("Org/x", {"Org/x": "X"}) == "X"
    assert person("sam-lee_acme") == "Sam"


class FakeGh:
    """gh as the gather calls it; records each command and the GH_TOKEN it saw."""

    def __init__(self):
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, argv, cwd=None):
        self.calls.append((argv, os.environ.get("GH_TOKEN")))
        if argv[:3] == ["gh", "auth", "token"]:
            return "tok-work\n"
        if argv[:3] == ["gh", "api", "user"]:
            return "me_work\n"
        if argv[:3] == ["gh", "pr", "list"]:
            if "open" in argv:
                return json.dumps([
                    {"number": 10, "title": "PROJ-1: base", "url": "u10", "state": "OPEN", "isDraft": False,
                     "baseRefName": "develop", "headRefName": "feature/a", "mergeable": "MERGEABLE",
                     "mergedAt": None, "reviewDecision": "APPROVED", "reviewRequests": [], "createdAt": "2026-11-25T00:00:00Z",
                     "updatedAt": "2026-11-26T00:00:00Z"},
                    {"number": 11, "title": "PROJ-2: on top", "url": "u11", "state": "OPEN", "isDraft": False,
                     "baseRefName": "feature/a", "headRefName": "feature/b", "mergeable": "MERGEABLE",
                     "mergedAt": None, "reviewDecision": "", "reviewRequests": [{"login": "sam-lee_x"}],
                     "createdAt": "2026-11-26T00:00:00Z", "updatedAt": "2026-11-26T00:00:00Z"},
                ])
            if "merged" in argv:
                return json.dumps([{"number": 9, "title": "PROJ-0: done", "url": "u9", "state": "MERGED", "isDraft": False,
                                    "baseRefName": "develop", "headRefName": "feature/z", "mergeable": "UNKNOWN",
                                    "mergedAt": "2026-11-20T00:00:00Z", "reviewDecision": "APPROVED", "reviewRequests": [],
                                    "createdAt": "2026-11-19T00:00:00Z", "updatedAt": "2026-11-20T00:00:00Z"}])
            return "[]"
        if argv[:3] == ["gh", "pr", "view"]:
            return json.dumps({"commits": [{"committedDate": "2026-11-26T00:00:00Z", "messageHeadline": "x"}],
                               "reviews": [], "comments": []})
        if argv[:2] == ["gh", "api"]:
            return "[]"
        raise AssertionError(argv)


def test_the_tracker_reads_open_and_merged_with_the_configured_account():
    gh = FakeGh()
    cfg = {"ledger_dir": "/tmp", "providers": {"code": {"type": "github", "account": "me_work",
                                                        "repos": {"Org/notes-api": "/x"}}}}
    before = os.environ.get("GH_TOKEN")
    out = GitHubCode().gather(Context(cfg=cfg, day=date(2026, 11, 27), run=gh))
    assert os.environ.get("GH_TOKEN") == before
    assert all(tok == "tok-work" for argv, tok in gh.calls if argv[:3] != ["gh", "auth", "token"])
    merged_call = next(argv for argv, _ in gh.calls if argv[:3] == ["gh", "pr", "list"] and "merged" in argv)
    assert "merged:>=2026-10-28" in merged_call
    rows = [(r["label"], r["number"], r["status"], r["note"], r["tickets"]) for r in out["tracker"]]
    assert rows == [
        ("API", 11, "blocked", "waits for API #10", ["PROJ-2"]),
        ("API", 10, "approved", "ready to merge", ["PROJ-1"]),
        ("API", 9, "merged", "", ["PROJ-0"]),
    ]
