"""GitHub through the gh CLI and its own sign-in (gh auth login). Read-only."""

from __future__ import annotations

import json

from ..contract import KEY, Context, provider


class GitHubCode:
    source = "github"

    def gather(self, ctx: Context) -> dict:
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
