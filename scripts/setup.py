"""Set Daybook up: a few answers in, a working config out, the gather agent written, the doctor run.

    python3 scripts/setup.py                       # asks in the terminal
    python3 scripts/setup.py --answers a.json      # no questions (the /daybook-setup skill uses this)
    python3 scripts/setup.py --print               # show the config, write nothing

An existing config is kept as <config>.bak-<time> before a new one is written. Secrets are never
asked for: a token is named by where it lives (an environment variable or the macOS Keychain).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path(os.path.expanduser(os.environ.get("DAYBOOK_CONFIG") or "~/.claude/daybook/config.json"))

# What each choice needs. Connector tool names differ per account, so the skill passes the real ones.
CHAT = ("teams", "slack", "none")
MAIL = ("outlook", "gmail", "none")
TICKETS = ("jira", "none")


def repo_of(path: str) -> str | None:
    """owner/name from a checkout's origin remote (GitHub, GitLab or Bitbucket, https or ssh)."""
    try:
        url = subprocess.run(["git", "-C", os.path.expanduser(path), "remote", "get-url", "origin"],
                             check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?$", url)
    return m.group(1) if m else None


def minutes(text: str | int) -> int:
    """'8h 15m', '8:15', '8.25' or a number of minutes."""
    if isinstance(text, int):
        return text
    t = str(text).strip().lower()
    if m := re.fullmatch(r"(\d+)\s*h(?:\s*(\d+)\s*m)?", t):
        return int(m.group(1)) * 60 + int(m.group(2) or 0)
    if m := re.fullmatch(r"(\d+):(\d{2})", t):
        return int(m.group(1)) * 60 + int(m.group(2))
    if re.fullmatch(r"\d+(\.\d+)?", t):
        v = float(t)
        return int(v * 60) if v < 24 else int(v)
    raise ValueError(f"not a duration: {text!r} (try 8h 15m)")


def build(a: dict) -> dict:
    """The config for these answers. Pure, so it is tested without a terminal."""
    name = a["name"].strip()
    repos = {}
    for path in a.get("repos", []):
        full = repo_of(path) if "/" not in path or os.path.isdir(os.path.expanduser(path)) else None
        if full:
            repos[full] = os.path.expanduser(path)
    providers: dict = {"code": {"type": "github", "via": "cli", "repos": repos}}
    t = a.get("tickets", "none")
    if t == "jira":
        site = a["jira_site"].rstrip("/")
        if not site.startswith("http"):
            site = f"https://{site}"
        providers["tickets"] = {"type": "jira", "via": "api", "site": site, "url_template": "{site}/browse/{key}"}
        if a.get("jira_project"):
            providers["tickets"]["project"] = a["jira_project"]
        if a.get("jira_token_env"):
            providers["tickets"]["email"] = {"env": a.get("jira_email_env", "JIRA_EMAIL")}
            providers["tickets"]["token"] = {"env": a["jira_token_env"]}
        providers["time"] = {"type": "jira_worklogs", "via": "api"}
    else:
        providers["tickets"] = {"type": "none"}
    for cat, choices in (("chat", CHAT), ("mail", MAIL)):
        kind = a.get(cat, "none")
        if kind not in choices:
            raise ValueError(f"{cat}: {kind!r} is not one of {', '.join(choices)}")
        providers[cat] = {"type": kind}
        if kind != "none":
            providers[cat].update({"via": "connector", "tools": a.get(f"{cat}_tools", [])})
            if cat == "chat" and a.get("search_terms"):
                providers[cat]["search_terms"] = a["search_terms"]
    cfg = {
        "me": name,
        "call_me": a.get("call_me") or name.split(" ")[0],
        "reviewer": a.get("reviewer", ""),
        "watch_people": [p for p in [a.get("reviewer"), *a.get("watch_people", [])] if p],
        "ledger_dir": a.get("ledger_dir") or "~/daybook-ledger",
        "ledger_keep_days": 60,
        "day_min_minutes": minutes(a.get("day_min", "7h 30m")),
        "day_max_minutes": minutes(a.get("day_max", "8h 30m")),
        "gather_command": str(ROOT / "scripts" / "gather.sh"),
        "questions_since": datetime.now().date().isoformat(),
        "providers": providers,
        "people": a.get("people", {}),
    }
    if cfg["day_min_minutes"] > cfg["day_max_minutes"]:
        raise ValueError("the day's minimum is above its maximum")
    if not repos and a.get("repos"):
        raise ValueError("none of the repo folders has a git remote called origin")
    return cfg


def ask(prompt: str, default: str = "") -> str:
    got = input(f"{prompt}{f' [{default}]' if default else ''}: ").strip()
    return got or default


def interview() -> dict:
    print("Daybook setup: six questions. Enter keeps the default in [brackets].\n")
    a: dict = {"name": ask("1. Your name as your team's tools show it (e.g. Alex Example)")}
    a["reviewer"] = ask("2. Who reviews your work (their display name, optional)")
    a["repos"] = [p.strip() for p in ask("3. Folders of the repos you work in, comma-separated", os.getcwd()).split(",")]
    a["tickets"] = ask("4. Ticket tracker: jira or none", "jira")
    if a["tickets"] == "jira":
        a["jira_site"] = ask("   Jira site (e.g. you.atlassian.net)")
        a["jira_project"] = ask("   Project key (optional)")
    a["chat"] = ask("5. Chat: teams, slack or none", "none")
    a["mail"] = ask("6. Mail and calendar: outlook, gmail or none", "none")
    a["day_min"] = ask("   A working day is at least", "7h 30m")
    a["day_max"] = ask("   and at most", "8h 30m")
    return a


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="setup.py")
    ap.add_argument("--answers", help="a JSON file of answers, instead of asking")
    ap.add_argument("--print", action="store_true", help="show the config and write nothing")
    args = ap.parse_args(argv)
    answers = json.loads(Path(args.answers).read_text()) if args.answers else interview()
    try:
        cfg = build(answers)
    except (KeyError, ValueError) as e:
        print(f"setup: {e}", file=sys.stderr)
        return 2
    text = json.dumps(cfg, indent=2, ensure_ascii=False) + "\n"
    if args.print:
        sys.stdout.write(text)
        return 0
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    if CONFIG.exists():
        backup = CONFIG.with_name(f"{CONFIG.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
        CONFIG.replace(backup)
        print(f"kept your old config as {backup}")
    CONFIG.write_text(text)
    Path(os.path.expanduser(cfg["ledger_dir"])).mkdir(parents=True, exist_ok=True)
    print(f"wrote {CONFIG}")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "install_agent.py")], check=False)
    print("\nChecking connections:\n")
    return subprocess.run(["sh", str(ROOT / "scripts" / "doctor.sh")], check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
