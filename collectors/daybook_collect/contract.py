"""The adapter contract: what every provider implements, and the context it is given.

Reads return a day-file section (schema/day.schema.json, version 1). Writes are declared here so a
skill can ask whether a provider supports one; nothing in the collectors calls a write.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Protocol, TypedDict

# A ticket key: PROJ-123. Trackers without keys (GitHub Issues) override KEY in their adapter.
KEY = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")

Runner = Callable[[list[str], "str | None"], str]


def run(argv: list[str], cwd: str | None = None) -> str:
    """Run a command and return its output; a failure raises with the command's own message."""
    out = subprocess.run(argv, check=False, cwd=cwd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300] or f"exit {out.returncode}")
    return out.stdout


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def day_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time.min).astimezone()
    return start, start + timedelta(days=1)


def config_path() -> Path:
    return Path(os.path.expanduser(os.environ.get("DAYBOOK_CONFIG") or "~/.claude/daybook/config.json"))


def load_config(path: Path | None = None) -> dict:
    cfg = json.loads((path or config_path()).read_text())
    cfg["ledger_dir"] = os.path.expanduser(cfg["ledger_dir"])
    return cfg


class Provider(TypedDict, total=False):
    type: str
    via: str
    site: str
    project: str
    url_template: str
    repos: dict[str, str]
    start_date_field: str
    board: dict
    token: dict
    email: dict


def provider(cfg: dict, category: str) -> Provider:
    """The config's provider for a category, filled from the older top-level keys where the
    config predates the providers block, so an old config keeps working."""
    p: Provider = dict(cfg.get("providers", {}).get(category, {}))  # type: ignore[assignment]
    if category == "code":
        p.setdefault("type", "github")
        p.setdefault("repos", cfg.get("repos", {}))
    elif category == "tickets":
        p.setdefault("type", "jira")
        if cfg.get("jira_site"):
            p.setdefault("site", cfg["jira_site"])
        if cfg.get("start_date_field"):
            p.setdefault("start_date_field", cfg["start_date_field"])
        if cfg.get("board"):
            p.setdefault("board", cfg["board"])
    return p


@dataclass
class Context:
    cfg: dict
    day: date
    run: Runner = run
    extra_keys: set[str] = field(default_factory=set)


class CodeAdapter(Protocol):
    """Pull requests (or merge requests) and their reviews: the day file's "github" section."""

    source: str

    def gather(self, ctx: Context) -> dict: ...


class TicketsAdapter(Protocol):
    """The day's tickets, today's and the week's time, and the board: the "jira" section."""

    source: str

    def gather(self, ctx: Context) -> dict: ...


class TicketsWriter(Protocol):
    """Writes a tracker may support; a skill checks `supports` first and skips what is missing.
    Every write happens only in a skill, after the user's yes."""

    supports: frozenset[str]  # of "log_time", "move_ticket", "set_date"

    def log_time(self, key: str, seconds: int, started: datetime) -> str: ...

    def move_ticket(self, key: str, to_status: str) -> None: ...

    def set_date(self, key: str, field_name: str, value: date) -> None: ...
