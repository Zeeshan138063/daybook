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
import re
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol

from ..contract import Context, day_bounds, provider

KEY = re.compile(r"^[A-Z][A-Z0-9]*-\d+$")


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
            "mine": self.mine(client, ctx, fields + ["priority"]),
            **self.orders(client, ctx),
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
    def mine(client: Client, ctx: Context, fields: list[str]) -> list[dict]:
        """For the Scrum card: every open ticket assigned to me, plus every ticket the last week's
        scrum plans name (so a planned ticket that is now Done still shows how it ended)."""
        start_field = provider(ctx.cfg, "tickets").get("start_date_field", "")

        def paged(jql: str) -> list[dict]:
            found: list[dict] = []
            token = None
            while True:
                body: dict = {"jql": jql, "fields": fields, "maxResults": 100}
                if token:
                    body["nextPageToken"] = token
                page = client.request("POST", "search/jql", json=body)
                found += page.get("issues", [])
                token = page.get("nextPageToken")
                if not token or len(found) >= 500:
                    return found

        issues = {i["key"]: i for i in paged("assignee = currentUser() AND statusCategory != Done ORDER BY key")}
        planned = sorted(planned_keys(ctx) - issues.keys())
        if planned:
            issues.update({i["key"]: i for i in paged(f"key in ({','.join(planned)})")})
        rows = []
        for key in sorted(issues, key=lambda k: (k.split("-")[0], int(k.split("-")[1]))):
            f = issues[key]["fields"]
            rows.append({
                "key": key,
                "summary": f["summary"],
                "status": f["status"]["name"],
                "assignee": (f.get("assignee") or {}).get("displayName"),
                "start_date": f.get(start_field) if start_field else None,
                "due_date": f.get("duedate"),
                "updated": f.get("updated"),
                "priority": (f.get("priority") or {}).get("name"),
            })
        return rows

    # Your board's order: the To Do tickets assigned to you, in the board's rank.
    BOARD_ORDER_JQL = 'assignee = currentUser() AND statusCategory = "To Do" ORDER BY Rank ASC'

    @staticmethod
    def orders(client: Client, ctx: Context) -> dict:
        """For the Scrum card's "My board order" and "custom search" rules: ticket keys in each
        query's own order. A query that fails is recorded under order_errors; the rest still run."""
        queries = {"board": JiraTickets.BOARD_ORDER_JQL}
        custom = scrum_settings(ctx).get("custom_jql", "").strip()
        if custom:
            queries["custom"] = custom
        orders: dict[str, list[str]] = {}
        errors: dict[str, str] = {}
        for name, jql in queries.items():
            try:
                page = client.request("POST", "search/jql", json={"jql": jql, "fields": ["summary"], "maxResults": 100})
                orders[name] = [i["key"] for i in page.get("issues", [])]
            except Exception as e:  # noqa: BLE001 - shown on the card, never hides the other rules
                errors[name] = str(e)[:200]
        return {"orders": orders, "order_errors": errors}

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


def scrum_settings(ctx: Context) -> dict:
    """The Scrum card's picking settings (<ledger_dir>/scrum.json, "settings"), or {}."""
    try:
        data = jsonlib.loads((Path(ctx.cfg["ledger_dir"]).expanduser() / "scrum.json").read_text())
    except (OSError, ValueError):
        return {}
    settings = data.get("settings")
    return settings if isinstance(settings, dict) else {}


def planned_keys(ctx: Context, days: int = 7) -> set[str]:
    """Ticket keys in the Scrum card's plans (<ledger_dir>/scrum.json) from the last `days` days."""
    try:
        plans = jsonlib.loads((Path(ctx.cfg["ledger_dir"]).expanduser() / "scrum.json").read_text()).get("days", {})
    except (OSError, ValueError):
        return set()
    since = (ctx.day - timedelta(days=days)).isoformat()
    return {i["key"] for d, p in plans.items() if d >= since for i in p.get("items", []) if KEY.match(i.get("key", ""))}


def area_of(parent_summary: str, board_cfg: dict) -> str:
    """The board area: the first configured area whose phrase is in the parent story's name."""
    s = parent_summary.lower()
    for area, phrases in board_cfg.get("areas", {}).items():
        if any(ph.lower() in s for ph in phrases):
            return area
    return board_cfg.get("default_area", "backend")

