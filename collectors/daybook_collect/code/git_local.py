"""Your own commits of the day in the local checkouts the config lists. Read-only."""

from __future__ import annotations

from pathlib import Path

from ..contract import KEY, Context, day_bounds, provider


class LocalGit:
    source = "git"

    def gather(self, ctx: Context) -> dict:
        start, end = day_bounds(ctx.day)
        commits = []
        for repo, path in provider(ctx.cfg, "code").get("repos", {}).items():
            if not path or not Path(path).is_dir():
                continue
            author = ctx.run(["git", "config", "user.name"], path).strip()
            log = ctx.run([
                "git", "log", "--all", f"--author={author}",
                f"--since={start.isoformat()}", f"--until={end.isoformat()}",
                "--format=%H%x09%cI%x09%D%x09%s",
            ], path)
            for line in log.splitlines():
                sha, when, _refs, subject = (line.split("\t") + ["", "", "", ""])[:4]
                m = KEY.match(subject)
                commits.append({"repo": repo, "sha": sha[:10], "at": when, "subject": subject,
                                "ticket": m.group(1) if m else None})
        return {"commits": commits}
