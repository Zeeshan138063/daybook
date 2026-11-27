"""The PR tracker's status for each pull request: one rule set, from what the code host returns.

    merged          merged within the window
    draft           still a draft
    needs_fixes     changes requested, or reviewer comments newer than the last push
    blocked         conflicts with its base, or stacked on a pull request that is still open
    approved        approved and nothing above applies: ready to merge
    back_for_review the author pushed after the reviewer's last comments
    in_review       waiting for a first review

A reviewer is anyone but the author and bots. Resolved review threads are not visible here, so a
pull request reads needs_fixes until the author pushes again.
"""

from __future__ import annotations

from datetime import datetime

ORDER = ["needs_fixes", "blocked", "back_for_review", "in_review", "approved", "draft", "merged"]


def _t(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso)
    except ValueError:
        return None


def is_bot(login: str) -> bool:
    return login.endswith("[bot]") or login in {"github-actions", "dependabot", "copilot"}


def person(login: str) -> str:
    """A reviewer's short name: sam-lee_acme → Sam."""
    first = login.split("_")[0].split("-")[0]
    return first[:1].upper() + first[1:]


def label(repo: str, labels: dict[str, str] | None = None) -> str:
    """A repository's short label: the config's, else the last word of its name when short (api → API)."""
    if labels and repo in labels:
        return labels[repo]
    tail = repo.split("/")[-1].split("-")[-1]
    return tail.upper() if len(tail) <= 4 else repo.split("/")[-1]


def status(pr: dict, author: str, open_heads: dict[str, str]) -> tuple[str, str]:
    """(status, note) for one pull request. open_heads maps an open PR's head branch to its label
    ("API #623"), so a PR based on it reads "waits for API #623"."""
    if pr.get("mergedAt"):
        return "merged", ""
    if pr.get("isDraft"):
        return "draft", ""
    last_push = max((t for t in (_t(c.get("committedDate")) for c in pr.get("commits", [])) if t), default=None)
    others = [r for r in pr.get("activity", []) if r["by"] != author and not is_bot(r["by"])]
    newer = [r for r in others if last_push is None or ((_t(r["at"]) or last_push) > last_push)]
    changes = pr.get("reviewDecision") == "CHANGES_REQUESTED"
    if newer or (changes and not others):
        who = sorted({person(r["by"]) for r in newer}) or ["Reviewer"]
        when = max((r["at"] for r in newer), default="")[:10]
        count = sum(1 for r in newer if r.get("kind") != "review")
        asked = changes or any(r.get("state") == "CHANGES_REQUESTED" for r in newer)
        what = (f"{count} {'comment' if count == 1 else 'comments'}" if count
                else "changes requested" if asked else "reviewed")
        return "needs_fixes", f"{', '.join(who)}: {what}{f' · {when}' if when else ''}"
    if pr.get("mergeable") == "CONFLICTING":
        return "blocked", "conflicts with its base"
    waits = open_heads.get(pr.get("baseRefName", ""))
    if waits:
        return "blocked", f"waits for {waits}"
    if pr.get("reviewDecision") == "APPROVED":
        return "approved", "ready to merge"
    if others:
        return "back_for_review", f"pushed after review · {last_push.date().isoformat() if last_push else ''}".rstrip(" ·")
    asked = [person(r) for r in pr.get("reviewRequests", [])]
    return "in_review", f"asked {', '.join(asked)}" if asked else "no reviewer asked yet"
