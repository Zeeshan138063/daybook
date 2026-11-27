"""GitHub through the gh CLI and its own sign-in (gh auth login). Read-only.

`providers.code.account` names the gh account to use (gh auth login can hold several); its token is
put in GH_TOKEN for the gather only, so the active account never decides whose pull requests are read.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta

from ..contract import KEY, Context, provider
from .tracker import ORDER, label, status

#: The tracker reads merged pull requests this far back; the panel narrows it to 7, 14 or 30 days.
TRACKER_DAYS = 30


@contextmanager
def account_token(ctx: Context, account: str) -> Iterator[None]:
    """GH_TOKEN set to `account`'s token while the block runs, then put back as it was."""
    if not account:
        yield
        return
    token = ctx.run(["gh", "auth", "token", "-u", account], None).strip()
    before = os.environ.get("GH_TOKEN")
    os.environ["GH_TOKEN"] = token
    try:
        yield
    finally:
        if before is None:
            os.environ.pop("GH_TOKEN", None)
        else:
            os.environ["GH_TOKEN"] = before


class GitHubCode:
    source = "github"

    def gather(self, ctx: Context) -> dict:
        with account_token(ctx, provider(ctx.cfg, "code").get("account", "")):
            out = self._gather(ctx)
            try:
                out["tracker"] = self.tracker(ctx, out["login"])
            except Exception as e:  # noqa: BLE001 - the tracker failing never loses the day's PRs
                out["tracker"], out["tracker_error"] = [], str(e)[:200]
            return out

    def _gather(self, ctx: Context) -> dict:
        run = ctx.run
        login = run(["gh", "api", "user", "--jq", ".login"], None).strip()
        prs = []
        for repo in provider(ctx.cfg, "code").get("repos", {}):
            listed = json.loads(run([
                "gh", "pr", "list", "--repo", repo, "--author", "@me", "--state", "all",
                "--search", f"updated:>={ctx.day.isoformat()}",
                "--json", ("number,title,url,state,baseRefName,headRefName,mergeable,mergedAt,"
                           "reviewDecision,createdAt"),
            ], None))
            for pr in listed:
                detail = json.loads(run([
                    "gh", "pr", "view", str(pr["number"]), "--repo", repo,
                    "--json", "commits,reviews,comments",
                ], None))
                inline = json.loads(run(["gh", "api", f"repos/{repo}/pulls/{pr['number']}/comments"], None))
                commits_by_ticket: dict[str, list[str]] = {}
                for c in detail["commits"]:
                    m = KEY.match(c["messageHeadline"])
                    commits_by_ticket.setdefault(m.group(1) if m else "other", []).append(c["messageHeadline"])
                prs.append({
                    "repo": repo,
                    **pr,
                    "tickets": sorted(set(KEY.findall(pr["title"])) | {k for k in commits_by_ticket if k != "other"}),
                    "commits_by_ticket": commits_by_ticket,
                    "reviews": [
                        {"by": r["author"]["login"], "state": r["state"], "at": r["submittedAt"]}
                        for r in detail["reviews"]
                    ],
                    "comments": [
                        {"by": c["author"]["login"], "at": c["createdAt"], "text": c["body"][:400]}
                        for c in detail["comments"]
                    ],
                    "inline_comments": [
                        {"by": c["user"]["login"], "at": c["created_at"], "path": c["path"],
                         "line": c.get("line"), "text": c["body"][:400], "in_reply_to": c.get("in_reply_to_id")}
                        for c in inline
                    ],
                })
        return {"login": login, "prs": prs}

    @staticmethod
    def tracker(ctx: Context, login: str) -> list[dict]:
        """Every open pull request of mine and every one merged in the last TRACKER_DAYS days, each
        with a status (code/tracker.py) and a one-line note."""
        run = ctx.run
        p = provider(ctx.cfg, "code")
        labels = p.get("labels") or {}
        since = (ctx.day - timedelta(days=TRACKER_DAYS)).isoformat()
        fields = ("number,title,url,state,isDraft,baseRefName,headRefName,mergeable,mergedAt,"
                  "reviewDecision,reviewRequests,createdAt,updatedAt")
        rows: list[dict] = []
        for repo in p.get("repos", {}):
            tag = label(repo, labels)
            open_prs = json.loads(run(["gh", "pr", "list", "--repo", repo, "--author", "@me", "--state", "open",
                                       "--limit", "100", "--json", fields], None))
            merged = json.loads(run(["gh", "pr", "list", "--repo", repo, "--author", "@me", "--state", "merged",
                                     "--search", f"merged:>={since}", "--limit", "100", "--json", fields], None))
            heads = {pr.get("headRefName", ""): f"{tag} #{pr['number']}" for pr in open_prs if pr.get("headRefName")}
            for pr in open_prs:
                detail = json.loads(run(["gh", "pr", "view", str(pr["number"]), "--repo", repo,
                                         "--json", "commits,reviews,comments"], None))
                inline = json.loads(run(["gh", "api", f"repos/{repo}/pulls/{pr['number']}/comments"], None))
                pr["commits"] = [{"committedDate": c.get("committedDate")} for c in detail.get("commits", [])]
                pr["activity"] = (
                    [{"by": r["author"]["login"], "at": r["submittedAt"], "kind": "review", "state": r["state"]}
                     for r in detail.get("reviews", []) if r.get("submittedAt")]
                    + [{"by": c["author"]["login"], "at": c["createdAt"], "kind": "comment"} for c in detail.get("comments", [])]
                    + [{"by": c["user"]["login"], "at": c["created_at"], "kind": "inline"} for c in inline]
                )
                pr["reviewRequests"] = [r.get("login") or r.get("name", "") for r in pr.get("reviewRequests") or []]
            for pr in open_prs + merged:
                st, note = status(pr, login, heads)
                rows.append({
                    "repo": repo, "label": tag, "number": pr["number"], "title": pr.get("title", ""), "url": pr.get("url", ""),
                    "tickets": sorted(set(KEY.findall(pr.get("title", "")))), "status": st, "note": note,
                    "base": pr.get("baseRefName", ""), "created_at": pr.get("createdAt"),
                    "merged_at": pr.get("mergedAt"), "updated_at": pr.get("updatedAt"),
                })
        rows.sort(key=lambda r: (ORDER.index(r["status"]), r.get("merged_at") or r.get("created_at") or ""))
        return rows
