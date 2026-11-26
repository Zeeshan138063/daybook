"""The Scrum card's two Jira moves, Start and Done, run from the panel after a Confirm.

    run.sh scrum move KEY --to start [--dry-run] [--day YYYY-MM-DD]
    run.sh scrum move KEY --to done  [--dry-run] [--day YYYY-MM-DD]

`start` takes a ticket from To Do into In Development and sets the start date (when it is empty).
`done` takes it from In Development into In Review and sets the due date to the day. Jira's own
"Done" means deployed to production, which is not the developer's step, so the card's Done is
In Review.

Prints one JSON object on stdout:

    {"key", "from", "to", "transition", "fields": {"Start date": [old, new]}, "wrote", "error"}

`--dry-run` reads the ticket and its transitions and says what would change; it writes nothing.
Without it the transition and the date are written, the ticket is read again, and the move is
appended to <ledger_dir>/moves.log (one JSON line each).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path

from .contract import Context, load_config, provider
from .tickets.jira import Client, make_client

# The card's columns, by Jira status name.
TODO = {"Backlog", "Open", "Ready for Development", "To Do", "Selected for Development"}
DOING = {"In Development", "In Progress"}
MOVES = {
    "start": {"from": TODO, "to": "In Development", "field": "start"},
    "done": {"from": DOING, "to": "In Review", "field": "due"},
}


def plan(client: Client, cfg: dict, key: str, move: str, day: str) -> dict:
    """What `move` would do to `key`: its transition and its date field, or why it can't."""
    spec = MOVES[move]
    start_field = provider(cfg, "tickets").get("start_date_field", "")
    fields = ["status", "duedate"] + ([start_field] if start_field else [])
    issue = client.request("GET", f"issue/{key}", params={"fields": ",".join(fields)})
    f = issue.get("fields", {})
    status = f["status"]["name"]
    out: dict = {"key": key, "from": status, "to": spec["to"], "transition": None, "fields": {},
                 "wrote": False, "error": None}
    if status not in spec["from"]:
        out["error"] = f"{key} is {status}; {move} moves a ticket from {' or '.join(sorted(spec['from']))}"
        return out
    options = client.request("GET", f"issue/{key}/transitions").get("transitions", [])
    match = next((t for t in options if (t.get("to") or {}).get("name") == spec["to"]), None)
    if not match:
        out["error"] = f"Jira offers no transition from {status} to {spec['to']} on {key}"
        return out
    out["transition"] = {"id": match["id"], "name": match["name"]}
    if spec["field"] == "start" and start_field and not f.get(start_field):
        out["fields"]["Start date"] = [None, day]
        out["_set"] = {start_field: day}
    if spec["field"] == "due" and f.get("duedate") != day:
        out["fields"]["Due date"] = [f.get("duedate"), day]
        out["_set"] = {"duedate": day}
    return out


def apply(client: Client, out: dict) -> dict:
    """Write a plan: the transition, then the date field, then read the status back."""
    key = out["key"]
    client.request("POST", f"issue/{key}/transitions", json={"transition": {"id": out["transition"]["id"]}})
    if out.get("_set"):
        client.request("PUT", f"issue/{key}", json={"fields": out["_set"]})
    after = client.request("GET", f"issue/{key}", params={"fields": "status"})
    out["to"] = after["fields"]["status"]["name"]
    out["wrote"] = True
    return out


def move(client: Client, cfg: dict, key: str, kind: str, day: str, dry_run: bool) -> dict:
    out = plan(client, cfg, key, kind, day)
    if not out["error"] and not dry_run:
        try:
            out = apply(client, out)
        except Exception as e:  # noqa: BLE001 - a failed write is reported, never retried blindly
            out["error"] = f"Jira refused the write: {str(e)[:200]}"
    out.pop("_set", None)
    return out


def log(cfg: dict, out: dict, kind: str) -> None:
    path = Path(cfg["ledger_dir"]).expanduser() / "moves.log"
    entry = {"at": datetime.now().astimezone().isoformat(timespec="seconds"), "move": kind,
             **{k: out[k] for k in ("key", "from", "to", "fields")}}
    with path.open("a") as fh:
        fh.write(json.dumps(entry) + "\n")


def main(argv: list[str] | None = None, client: Client | None = None) -> int:
    ap = argparse.ArgumentParser(prog="scrum")
    sub = ap.add_subparsers(dest="cmd", required=True)
    mv = sub.add_parser("move")
    mv.add_argument("key")
    mv.add_argument("--to", choices=sorted(MOVES), required=True)
    mv.add_argument("--dry-run", action="store_true")
    mv.add_argument("--day", default=date.today().isoformat())
    args = ap.parse_args(argv)
    cfg = load_config()
    try:
        client = client or make_client(Context(cfg=cfg, day=date.fromisoformat(args.day)))
        out = move(client, cfg, args.key.upper(), args.to, args.day, args.dry_run)
    except Exception as e:  # noqa: BLE001 - shown on the card, never raised
        out = {"key": args.key, "error": f"Jira could not be reached: {str(e)[:200]}", "wrote": False}
    if out.get("wrote"):
        log(cfg, out, args.to)
    print(json.dumps(out))
    return 0 if not out.get("error") else 1


if __name__ == "__main__":
    sys.exit(main())
