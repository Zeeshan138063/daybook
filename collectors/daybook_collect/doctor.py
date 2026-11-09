"""Doctor: is every tool connected? One line per check, a tick or the exact fix. Read-only.

    python3 -m daybook_collect.doctor           # human lines
    python3 -m daybook_collect.doctor --json    # for the panel and the setup wizard

Chat and mail go through connectors that only the gather agent can reach, so for those the doctor
reports what the agent's last run recorded in the newest day file, and whether the agent itself
is installed with the tools the config names.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

from .contract import config_path, provider

AGENT_FILE = Path("~/.claude/agents/daybook-gather.md").expanduser()


@dataclass
class Check:
    area: str
    ok: bool
    what: str
    fix: str = ""


Probe = Callable[[list[str]], tuple[int, str]]


def _probe(argv: list[str]) -> tuple[int, str]:
    try:
        out = subprocess.run(argv, check=False, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, str(e)
    return out.returncode, (out.stdout + out.stderr).strip()


def check_config(path: Path) -> tuple[list[Check], dict | None]:
    if not path.exists():
        return [Check("config", False, f"no config at {path}", "run /daybook-setup")], None
    try:
        cfg = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return [Check("config", False, f"{path} is not valid JSON ({e.msg}, line {e.lineno})",
                      "fix the file, or run /daybook-setup again")], None
    missing = [k for k in ("me", "ledger_dir", "day_min_minutes", "day_max_minutes") if k not in cfg]
    checks = [Check("config", not missing, f"config {path}" + (f": missing {', '.join(missing)}" if missing else ""),
                    "run /daybook-setup" if missing else "")]
    ledger = Path(os.path.expanduser(cfg.get("ledger_dir", "")))
    checks.append(Check("config", ledger.is_dir(), f"day files in {ledger}",
                        "" if ledger.is_dir() else f"mkdir -p {ledger}"))
    return checks, cfg


def check_code(cfg: dict, probe: Probe) -> list[Check]:
    p = provider(cfg, "code")
    kind = p.get("type", "github")
    checks: list[Check] = []
    if kind == "github":
        if not shutil.which("gh"):
            checks.append(Check("code", False, "GitHub CLI (gh) not found", "brew install gh, then gh auth login"))
        else:
            code, out = probe(["gh", "auth", "status"])
            who = next((w.split("account ")[-1].split(" ")[0] for w in out.splitlines() if "account" in w), "")
            checks.append(Check("code", code == 0, f"GitHub signed in{f' as {who}' if who else ''}" if code == 0
                                else "GitHub CLI is not signed in", "" if code == 0 else "gh auth login"))
    else:
        checks.append(Check("code", False, f"code provider '{kind}' has no adapter yet",
                            "see docs/connect: GitHub is supported today"))
    for repo, path in p.get("repos", {}).items():
        local = Path(os.path.expanduser(path))
        ok = (local / ".git").exists()
        checks.append(Check("code", ok, f"{repo} checked out at {local}",
                            "" if ok else f"git clone the repo there, or fix providers.code.repos['{repo}']"))
    return checks


def check_tickets(cfg: dict, client_factory: Callable[[], object] | None) -> list[Check]:
    p = provider(cfg, "tickets")
    kind = p.get("type", "jira")
    if kind == "none":
        return [Check("tickets", True, "tickets: not configured (optional)")]
    if kind != "jira":
        return [Check("tickets", False, f"ticket provider '{kind}' has no adapter yet", "see docs/connect")]
    if not p.get("site"):
        return [Check("tickets", False, "Jira site not set", "set providers.tickets.site, e.g. https://you.atlassian.net")]
    if client_factory is None:
        return [Check("tickets", False, "Jira not checked", "install jira-agent, or set providers.tickets.email and token")]
    try:
        me = client_factory().request("GET", "myself")  # type: ignore[attr-defined]
        return [Check("tickets", True, f"Jira {p['site']} signed in as {me.get('displayName', '?')}")]
    except Exception as e:  # noqa: BLE001 - every failure is shown as a fix, never raised
        hint = "jira-agent auth login" if not p.get("token") else "check the token providers.tickets.token points to"
        return [Check("tickets", False, f"Jira {p['site']}: {str(e)[:120]}", hint)]


def newest_day_file(ledger: Path) -> Path | None:
    files = sorted(f for f in ledger.glob("????-??-??.json"))
    return files[-1] if files else None


def check_connectors(cfg: dict) -> list[Check]:
    checks: list[Check] = []
    agent = AGENT_FILE.read_text() if AGENT_FILE.exists() else ""
    if not agent:
        checks.append(Check("agent", False, "gather agent not installed", "python3 scripts/install_agent.py"))
    day = newest_day_file(Path(os.path.expanduser(cfg.get("ledger_dir", ""))))
    sources = json.loads(day.read_text()).get("sources", {}) if day else {}
    for cat, section in (("chat", "teams"), ("mail", "outlook")):
        p = provider(cfg, cat)
        kind = p.get("type", "none")
        if kind == "none":
            checks.append(Check(cat, True, f"{cat}: not configured (optional)"))
            continue
        tools = p.get("tools", [])
        missing = [t for t in tools if agent and t not in agent]
        if not tools:
            checks.append(Check(cat, False, f"{kind}: no connector tools named",
                                f"run /daybook-setup, or list the tool names under providers.{cat}.tools"))
            continue
        if missing:
            checks.append(Check(cat, False, f"{kind}: the agent lacks {len(missing)} tool(s)",
                                "python3 scripts/install_agent.py, then start a new session"))
            continue
        s = sources.get(section, {})
        when = f" ({day.stem}, {str(s.get('at', ''))[11:16]})" if day and s.get("at") else ""
        if s.get("ok"):
            checks.append(Check(cat, True, f"{kind}: reached by the agent's last run{when}"))
        else:
            err = s.get("error") or "not checked yet"
            checks.append(Check(cat, False, f"{kind}: {err}{when}",
                                "sign the connector in (Settings, Connectors), then press Refresh"))
    return checks


def check_tools() -> list[Check]:
    py = bool(shutil.which("python3"))
    out = [Check("tools", py, "python3 available", "" if py else "install Python 3.11+")]
    out.append(Check("tools", bool(shutil.which("uv")), "uv available (optional, for jira-agent)",
                     "" if shutil.which("uv") else "brew install uv"))
    return out


def run_all(path: Path | None = None, probe: Probe = _probe,
            client_factory: Callable[[], object] | None = None) -> list[Check]:
    path = path or config_path()
    checks, cfg = check_config(path)
    if cfg is None:
        return checks
    cfg["ledger_dir"] = os.path.expanduser(cfg["ledger_dir"])
    return checks + check_tools() + check_code(cfg, probe) + check_tickets(cfg, client_factory) + check_connectors(cfg)


def _jira_factory(cfg_path: Path) -> Callable[[], object] | None:
    try:
        from .contract import Context, load_config
        from .tickets.jira import make_client
    except ImportError:
        return None
    return lambda: make_client(Context(cfg=load_config(cfg_path), day=date.today()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="daybook_collect.doctor")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    path = config_path()
    checks = run_all(path, client_factory=_jira_factory(path))
    bad = [c for c in checks if not c.ok]
    if args.json:
        print(json.dumps({"ok": not bad, "checks": [asdict(c) for c in checks]}, indent=2))
        return 0
    width = max(len(c.area) for c in checks)
    for c in checks:
        print(f"{'✔' if c.ok else '✘'} {c.area.ljust(width)}  {c.what}" + (f"\n  {' ' * width}  → {c.fix}" if c.fix else ""))
    print(f"\n{len(checks) - len(bad)} of {len(checks)} ok" + ("" if not bad else f", {len(bad)} to fix"))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
