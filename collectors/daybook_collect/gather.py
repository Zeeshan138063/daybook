"""Build the day file's code, git and ticket parts with the adapters the config names. Read-only.

    python -m daybook_collect.gather --day 2026-11-03

It prints a short summary and saves <ledger_dir>/<day>.json, keeping the sections an earlier run of
the gather agent added (chat, mail, tests). A source that fails is recorded under "sources" with its
error, never skipped silently. The section names are those of day file version 1 ("github", "git",
"jira") whatever the provider, so the panel and the skills read every provider the same way.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path

from . import registry
from .contract import Context, load_config, now_iso, provider


def prune(ledger: Path, keep_days: int) -> None:
    cutoff = date.today() - timedelta(days=keep_days)
    for f in ledger.glob("*.json"):
        try:
            if date.fromisoformat(f.stem) < cutoff:
                f.unlink()
        except ValueError:
            continue


def gather(cfg: dict, day: date, data: dict, ctx_factory: Callable[[set[str]], Context] | None = None,
           code=None, git=None, tickets=None) -> dict:
    """Fill `data` (the day file so far) and return it. Adapters can be passed in, for tests."""
    make_ctx = ctx_factory or (lambda keys: Context(cfg=cfg, day=day, extra_keys=keys))
    data.update({"day": day.isoformat(), "gathered_at": now_iso()})
    sources = data.setdefault("sources", {})

    def attempt(name: str, fn):
        try:
            result = fn()
            sources[name] = {"ok": True, "at": now_iso()}
            return result
        except Exception as e:  # noqa: BLE001 - a failed source is recorded, never hidden
            sources[name] = {"ok": False, "at": now_iso(), "error": f"{type(e).__name__}: {e}"}
            return {}

    code_type = provider(cfg, "code")["type"]
    tickets_type = provider(cfg, "tickets")["type"]
    if code_type != "none":
        code = code or registry.CODE[code_type]()
        data["github"] = attempt(code.source, lambda: code.gather(make_ctx(set())))
        git = git or registry.LOCAL_GIT()
        data["git"] = attempt(git.source, lambda: git.gather(make_ctx(set())))
    keys = {k for pr in data.get("github", {}).get("prs", []) for k in pr["tickets"]}
    keys |= {c["ticket"] for c in data.get("git", {}).get("commits", []) if c["ticket"]}
    if tickets_type != "none":
        tickets = tickets or registry.TICKETS[tickets_type]()
        data["jira"] = attempt(tickets.source, lambda: tickets.gather(make_ctx(keys)))
    for category, kind in (("chat", "teams"), ("mail", "outlook")):
        name = cfg.get("providers", {}).get(category, {}).get("type", kind)
        if name != "none":
            sources.setdefault(name, {"ok": False, "error": "not checked yet (gather agent)"})
    sources.setdefault("tests", {"ok": False, "error": "not checked yet (gather agent)"})
    return data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default=date.today().isoformat())
    args = ap.parse_args()
    day = date.fromisoformat(args.day)
    cfg = load_config()
    ledger = Path(cfg["ledger_dir"])
    ledger.mkdir(parents=True, exist_ok=True)
    path = ledger / f"{day.isoformat()}.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    gather(cfg, day, data)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    prune(ledger, cfg.get("ledger_keep_days", 60))
    json.dump({"path": str(path), "sources": data["sources"]}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
