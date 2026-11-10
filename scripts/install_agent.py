"""Write the daybook-gather agent for this user from the template and their config.

    python3 scripts/install_agent.py            # writes ~/.claude/agents/daybook-gather.md
    python3 scripts/install_agent.py --dry-run  # prints it instead

The agent's tool list is exactly the tools the config names for chat and mail (each user's
connector tool names differ), plus Bash and Read, so it can reach nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ROOT / "agent-templates"  # not agents/: Claude Code would load these templates as agents
LABELS = {"github": "GitHub", "gitlab": "GitLab", "bitbucket": "Bitbucket", "jira": "Jira", "linear": "Linear",
          "teams": "Teams", "slack": "Slack", "outlook": "Outlook", "gmail": "Gmail"}
SECTION_NAME = {"teams": "teams", "slack": "teams", "outlook": "outlook", "gmail": "outlook"}


def fill(text: str, values: dict[str, str]) -> str:
    out = re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), m.group(0)), text)
    left = re.findall(r"\{\{(\w+)\}\}", out)
    if left:
        raise SystemExit(f"install_agent: no value for {sorted(set(left))}")
    return out


def section(category: str, key: str, n: int, p: dict, values: dict[str, str]) -> str:
    kind = p.get("type", "none")
    path = AGENTS / "sections" / f"{key}-{kind}.md"
    if kind == "none":
        return fill((AGENTS / "sections" / "none.md").read_text(),
                    {**values, "n": str(n), "category": category, "key": key, "type": kind})
    if not path.exists():
        raise SystemExit(f"install_agent: {category} provider '{kind}' has no agent section yet ({path.name})")
    return fill(path.read_text(), {**values, "search_terms": p.get("search_terms", "*")})


def render(cfg: dict, config_path: str) -> str:
    providers = cfg.get("providers", {})
    chat, mail = providers.get("chat", {"type": "none"}), providers.get("mail", {"type": "none"})
    code_t = providers.get("code", {}).get("type", "github")
    tickets = providers.get("tickets", {"type": "jira"})
    owner = cfg.get("me", "the user")
    names = [LABELS.get(code_t, code_t), "git", LABELS.get(tickets.get("type", ""), tickets.get("type", ""))]
    names += [LABELS.get(p["type"], p["type"]) for p in (chat, mail) if p.get("type", "none") != "none"]
    tools = ["Bash", "Read", *chat.get("tools", []), *mail.get("tools", [])]
    gather = cfg.get("gather_command", "~/.claude/daybook/gather.sh")
    values = {
        "owner": owner,
        "owner_first": cfg.get("call_me") or owner.split(" ")[0],
        "me": owner,
        "ledger_dir": cfg["ledger_dir"],
        "questions_file": cfg.get("questions_file") or f"{cfg['ledger_dir']}/questions.json",
        "config_path": config_path,
        "source_list": ", ".join(names[:-1]) + " and " + names[-1],
        "tools": ", ".join(dict.fromkeys(tools)),
        "model": cfg.get("agent_model", "sonnet"),
        "gather_command": f"sh {gather}",
        "questions_command": cfg.get("questions_command") or f"sh {ROOT / 'scripts' / 'questions.sh'}",
        "tickets_signin_hint": (
            "the fix is `jira-agent auth login`, which only the user can do."
            if tickets.get("type") == "jira" and not tickets.get("token")
            else "check the token the config names under providers.tickets."),
        "agent_sections": ", ".join(f"`{SECTION_NAME[p['type']]}`" for p in (chat, mail)
                                    if p.get("type") in SECTION_NAME) or "nothing else",
    }
    values["chat_section"] = section("Chat", "chat", 2, chat, values)
    values["mail_section"] = section("Mail", "mail", 3, mail, values)
    return fill((AGENTS / "daybook-gather.template.md").read_text(), values)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="~/.claude/agents/daybook-gather.md")
    args = ap.parse_args()
    config_path = os.environ.get("DAYBOOK_CONFIG") or "~/.claude/daybook/config.json"
    cfg = json.loads(Path(os.path.expanduser(config_path)).read_text())
    text = render(cfg, config_path)
    if args.dry_run:
        sys.stdout.write(text)
        return 0
    out = Path(os.path.expanduser(args.out))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
