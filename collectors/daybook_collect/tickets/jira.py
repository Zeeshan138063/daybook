"""Jira Cloud through its REST API (v3). Read-only.

Sign-in, in this order:
1. the jira-agent plugin's saved session, when it is installed (no token in any file);
2. `providers.tickets.email` and `providers.tickets.token`, each `{"env": NAME}` or
   `{"keychain": SERVICE}`, with `providers.tickets.site`.
"""

from __future__ import annotations

import base64
import json as jsonlib
import os
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Protocol

from ..contract import Context, day_bounds, provider


class Client(Protocol):
    def request(self, method: str, path: str, json: dict | None = None, params: dict | None = None) -> dict: ...


def secret(ref: dict | None) -> str:
    """A secret from where the config points: an environment variable or the macOS Keychain."""
    if not ref:
        return ""
    if "env" in ref:
        return os.environ.get(ref["env"], "")
    if "keychain" in ref:
        out = subprocess.run(["security", "find-generic-password", "-s", ref["keychain"], "-w"],
                             check=False, capture_output=True, text=True)
        return out.stdout.strip()
    return ""


class TokenClient:
    """Basic auth with an Atlassian account email and API token."""

    def __init__(self, site: str, email: str, token: str):
        self.base = site.rstrip("/") + "/rest/api/3/"
        self.auth = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()

    def request(self, method: str, path: str, json: dict | None = None, params: dict | None = None) -> dict:
        url = self.base + path + (("?" + urllib.parse.urlencode(params)) if params else "")
        body = None if json is None else jsonlib.dumps(json).encode()
        req = urllib.request.Request(url, data=body, method=method, headers={
            "Authorization": self.auth, "Accept": "application/json", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return jsonlib.loads(r.read() or b"{}")


def make_client(ctx: Context) -> Client:
    p = provider(ctx.cfg, "tickets")
    if p.get("token"):
        email, token = secret(p.get("email")), secret(p.get("token"))
        if not (p.get("site") and email and token):
            raise RuntimeError("Jira: providers.tickets needs site, email and token")
        return TokenClient(p["site"], email, token)
    try:
        from jira_agent.auth.keychain import default_store
        from jira_agent.client.http import JiraClient
        from jira_agent.config import ProfileStore
    except ImportError as e:
        raise RuntimeError("Jira: set providers.tickets.email and token, or install jira-agent") from e
    store = ProfileStore()
    profile = store.get(store.last_used_name())
    return JiraClient(profile.site_url, default_store())


class JiraTickets:
    source = "jira"

    def __init__(self, client: Client | None = None):
        self._client = client

    def gather(self, ctx: Context) -> dict:
        client = self._client or make_client(ctx)
        p = provider(ctx.cfg, "tickets")
        start_field = p.get("start_date_field", "")
        me = client.request("GET", "myself")
        fields = ["summary", "status", "duedate", "assignee", "updated", "parent"] + ([start_field] if start_field else [])

        def search(jql: str) -> list[dict]:
            return client.request("POST", "search/jql", json={"jql": jql, "fields": fields, "maxResults": 100}).get("issues", [])

        day = ctx.day
        day_s = day.isoformat()
        issues = {i["key"]: i for i in search(f'assignee = currentUser() AND updated >= "{day_s}" ORDER BY key')}
        logged = {i["key"]: i for i in search(f'worklogAuthor = currentUser() AND worklogDate = "{day_s}" ORDER BY key')}
        issues.update(logged)
        missing = sorted(ctx.extra_keys - issues.keys())
        if missing:
            for i in search(f"key in ({','.join(missing)})"):
                issues[i["key"]] = i

        start, end = day_bounds(day)
        tickets = []
        total = 0
        for key in sorted(issues, key=lambda k: (k.split("-")[0], int(k.split("-")[1]))):
            f = issues[key]["fields"]
            mine_today = []
            if key in logged:
                wl = client.request("GET", f"issue/{key}/worklog", params={
                    "startedAfter": int(start.timestamp() * 1000), "startedBefore": int(end.timestamp() * 1000)})
                for w in wl.get("worklogs", []):
                    if w["author"]["accountId"] == me["accountId"]:
                        mine_today.append({"id": w["id"], "started": w["started"], "seconds": w["timeSpentSeconds"]})
                        total += w["timeSpentSeconds"]
            tickets.append({
                "key": key,
                "summary": f["summary"],
                "status": f["status"]["name"],
                "assignee": (f.get("assignee") or {}).get("displayName"),
                "start_date": f.get(start_field) if start_field else None,
                "due_date": f.get("duedate"),
                "parent": (f.get("parent") or {}).get("key"),
                "updated": f["updated"],
                "worklogs_today": mine_today,
            })
        return {
            "account_id": me["accountId"],
            "board": self.board(client, ctx),
            "week_minutes": self.week(client, ctx, me["accountId"], search),
            "tickets": tickets,
            "logged_today_minutes": total // 60,
            "day_range_minutes": [ctx.cfg["day_min_minutes"], ctx.cfg["day_max_minutes"]],
        }

    @staticmethod
    def week(client: Client, ctx: Context, account: str, search) -> dict[str, int]:
        """The week's logged minutes per working day, Monday to Friday."""
        monday = ctx.day - timedelta(days=ctx.day.weekday())
        friday = monday + timedelta(days=4)
        week = {(monday + timedelta(days=i)).isoformat(): 0 for i in range(5)}
        w_start, _ = day_bounds(monday)
        _, w_end = day_bounds(friday)
        for i in search(f'worklogAuthor = currentUser() AND worklogDate >= "{monday.isoformat()}" '
                        f'AND worklogDate <= "{friday.isoformat()}"'):
            wl = client.request("GET", f"issue/{i['key']}/worklog", params={
                "startedAfter": int(w_start.timestamp() * 1000), "startedBefore": int(w_end.timestamp() * 1000)})
            for w in wl.get("worklogs", []):
                if w["author"]["accountId"] != account:
                    continue
                k = datetime.strptime(w["started"], "%Y-%m-%dT%H:%M:%S.%f%z").astimezone().date().isoformat()
                if k in week:
                    week[k] += w["timeSpentSeconds"] // 60
        return week

    @staticmethod
    def board(client: Client, ctx: Context) -> list[dict]:
        """Every ticket the board query finds, each with its area from its parent's name."""
        p = provider(ctx.cfg, "tickets")
        board_cfg = p.get("board")
        if not board_cfg:
            return []
        start_field = p.get("start_date_field", "")
        fields = ["summary", "status", "duedate", "assignee", "parent", "issuetype"] + ([start_field] if start_field else [])
        issues: list[dict] = []
        token = None
        while True:
            body: dict = {"jql": board_cfg["jql"], "fields": fields, "maxResults": 100}
            if token:
                body["nextPageToken"] = token
            page = client.request("POST", "search/jql", json=body)
            issues += page.get("issues", [])
            token = page.get("nextPageToken")
            if not token or len(issues) >= 1000:
                break
        rows = []
        for i in issues:
            f = i["fields"]
            parent = f.get("parent") or {}
            parent_summary = (parent.get("fields") or {}).get("summary", "")
            rows.append({
                "key": i["key"],
                "summary": f["summary"],
                "status": f["status"]["name"],
                "type": (f.get("issuetype") or {}).get("name", ""),
                "assignee": (f.get("assignee") or {}).get("displayName"),
                "start_date": f.get(start_field) if start_field else None,
                "due_date": f.get("duedate"),
                "parent": parent.get("key"),
                "parent_summary": parent_summary,
                "area": area_of(parent_summary, board_cfg),
            })
        return rows


def area_of(parent_summary: str, board_cfg: dict) -> str:
    """The board area: the first configured area whose phrase is in the parent story's name."""
    s = parent_summary.lower()
    for area, phrases in board_cfg.get("areas", {}).items():
        if any(ph.lower() in s for ph in phrases):
            return area
    return board_cfg.get("default_area", "backend")

