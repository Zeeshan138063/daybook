"""The questions list: each question you ask in chat is captured once, and closes when it's answered.

The gather agent only fetches. It writes the chat messages it read into an inbox file; this module
applies the rules, so the same messages always give the same list:

    python3 -m daybook_collect.questions merge <inbox.json> [--questions FILE] [--day-file FILE] [--jira]

Identity. A question's id is its chat message id, plus `#n` for the n-th numbered question in one
message, so reading a message twice never makes a second entry.

What counts as a question. A message from you, in a chat the config doesn't ignore, at least 20
characters long, that has a "?", "needs your OK", or opens with "one question", "two questions" and
the like, and doesn't open with "FYI" or say "no answer needed". Each numbered item that is itself a
question becomes its own entry.

What answers it, in order:
1. a reply that quotes it (the chat gives the quoted message's id);
2. a reply the agent marked as answering it (`answers`), for an answer that doesn't quote;
3. a later message from the person it was asked of, in the same chat, naming one of its tickets;
4. a dated "Decided (YYYY-MM-DD)" block on one of its tickets, on or after the day it was asked (--jira);
5. "Mark answered" in the panel (an `override`, which the merge never changes).

The cursor `scanned_until` says how far the agent has read, so the next fetch starts there.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.parse
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import TypedDict

MIN_LENGTH = 20
TICKET = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
ASKS = re.compile(r"\?|needs your ok|\b(?:one|two|three|four|five|six|a few|some|\d+)\s+(?:\w+\s+)?questions?\b",
                  re.IGNORECASE)
NOT_A_QUESTION = re.compile(r"^\s*fyi\b|no answer needed|nothing to answer", re.IGNORECASE)
# "Decided (2026-11-03): ..." and "Decision (Sam, 2026-11-07): ..." both count.
DECIDED = re.compile(r"(?:Decided|Decision)\b[^\n(]*\([^)\n]*?(\d{4}-\d{2}-\d{2})\)\s*:?\s*(.{0,240})", re.DOTALL)


class Message(TypedDict, total=False):
    id: str
    chat_id: str
    chat_label: str
    from_name: str
    to: str
    at: str
    html: str
    text: str
    url: str
    quotes: list[str]
    answers: list[str]
    gist: str
    topic: str


class Question(TypedDict, total=False):
    id: str
    message_id: str
    chat_id: str
    topic: str
    text: str
    tickets: list[str]
    to: str
    status: str
    asked_at: str
    answer: str
    answered_by: str
    answered_at: str
    answer_source: str
    answer_url: str
    url: str
    sent: bool
    override: dict


# ---------------------------------------------------------------- message text

class _Text(HTMLParser):
    """Chat HTML to plain text, keeping numbered list items as "n. " lines and their positions."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.lists: list[list[int]] = []  # a counter per open list, [] for an unordered one
        self.items: list[tuple[int, int]] = []  # (number, offset) of each top-level ordered item

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("p", "div", "br", "tr"):
            self.out.append("\n")
        elif tag == "ol":
            self.lists.append([0])
        elif tag == "ul":
            self.lists.append([])
        elif tag == "li":
            self.out.append("\n")
            if self.lists and self.lists[-1]:
                self.lists[-1][0] += 1
                n = self.lists[-1][0]
                if len(self.lists) == 1:  # numbered by position in the whole message, so ids never repeat
                    self.items.append((len(self.items) + 1, len("".join(self.out))))
                self.out.append(f"{n}. ")
            else:
                self.out.append("- ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("ol", "ul") and self.lists:
            self.lists.pop()
        elif tag in ("p", "div", "li"):
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        self.out.append(data)


def text_of(m: Message) -> tuple[str, list[tuple[int, str]]]:
    """A message's plain text and its numbered items [(n, item text)], n counting through the message."""
    return _parse(m)[:2]


def _parse(m: Message) -> tuple[str, list[tuple[int, str]], str]:
    """Text, numbered items, and the lead: the text before the first item."""
    if m.get("html"):
        p = _Text()
        p.feed(m["html"])
        full = "".join(p.out)
        offs = [off for _, off in p.items]
        starts = offs + [len(full)]
        items = [(n, _end_of_item(full[starts[i]:starts[i + 1]])) for i, (n, _) in enumerate(p.items)]
    else:
        full = html.unescape(m.get("text", ""))
        found = list(re.finditer(r"(?m)^\s*(\d+)[.)]\s+", full))
        offs = [f.start() for f in found]
        starts = offs + [len(full)]
        items = [(i + 1, full[starts[i]:starts[i + 1]].strip()) for i, _ in enumerate(found)]
    lead = full[: offs[0]] if offs else full
    clean = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", full)).strip()
    return clean, items, lead.strip()


def _end_of_item(chunk: str) -> str:
    """An item's own text: up to the blank line or paragraph that follows its list."""
    return re.split(r"\n\s*\n", chunk.strip(), maxsplit=1)[0].strip()


def one_line(text: str, limit: int = 140) -> str:
    s = re.sub(r"\s+", " ", text).strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def tickets_in(text: str) -> list[str]:
    return list(dict.fromkeys(TICKET.findall(text)))


def is_question(text: str) -> bool:
    return len(text) >= MIN_LENGTH and bool(ASKS.search(text)) and not NOT_A_QUESTION.search(text)


def ignored(m: Message, rules: dict) -> bool:
    if m.get("chat_id") in set(rules.get("ignore_chats", [])):
        return True
    text = (m.get("text") or text_of(m)[0]).lstrip()
    return any(text.startswith(p) for p in rules.get("ignore_prefixes", []))


# ---------------------------------------------------------------- finding questions

def questions_in(m: Message) -> list[Question]:
    """The questions one of your messages asks: one per numbered question item, else one."""
    text, items, lead = _parse(m)
    if not is_question(text):
        return []
    base: Question = {
        "message_id": m["id"], "chat_id": m.get("chat_id", ""), "to": m.get("to", ""),
        "asked_at": m.get("at", ""), "url": m.get("url", ""), "status": "waiting",
    }
    asked = [(n, t) for n, t in items if is_question(t)]
    # When the opening itself asks ("who should I send these to?"), the lists below it are content.
    if len(asked) < 2 or ("?" in lead and len(lead) >= MIN_LENGTH):
        return [{**base, "id": m["id"], "text": one_line(text, 600),
                 "topic": m.get("topic") or one_line(_lead(text)), "tickets": tickets_in(text)}]
    lead = tickets_in(text.split("\n")[0])
    return [{**base, "id": f"{m['id']}#{n}", "text": one_line(t, 600),
             "topic": one_line(_lead(t)), "tickets": tickets_in(t) or lead or tickets_in(text)}
            for n, t in asked]


def _lead(text: str) -> str:
    """The sentence a question starts with, without a greeting."""
    s = re.sub(r"^(hi|hello|hey|dear)\b[^,.:\n]*[,.:]?\s*", "", text.strip(), flags=re.IGNORECASE)
    s = re.sub(r"^\d+[.)]\s*", "", s)
    first = re.split(r"(?<=[.?!:])\s|\n", s, maxsplit=1)[0]
    return first or s


# ---------------------------------------------------------------- merging

def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()[:80]


def _at(s: str) -> datetime:
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def message_id_of(q: Question) -> str:
    """The chat message a question came from, also for entries written before ids were message ids."""
    if q.get("message_id"):
        return q["message_id"]
    m = re.search(r"/(\d{10,})(?:\?|$)", q.get("url", ""))
    return m.group(1) if m else ""


def adopt_ids(questions: list[Question]) -> None:
    """Give older entries their message id and chat, so a re-read message matches them instead of adding one."""
    for q in questions:
        mid = message_id_of(q)
        if mid and not q.get("message_id"):
            q["message_id"] = mid
            q["id"] = mid
        chat = re.search(r"/l/message/([^/?]+)/\d+", q.get("url") or "")
        if chat and not q.get("chat_id"):
            q["chat_id"] = urllib.parse.unquote(chat.group(1))


def merge(questions: list[Question], messages: Iterable[Message], me: str, rules: dict | None = None,
          decided: Callable[[str], list[tuple[str, str]]] | None = None, relay: str = "") -> dict[str, int]:
    """Add new questions and close answered ones, in place. Returns counts of what changed.

    `relay` is the person who carries questions to others (the reviewer): a question asked of someone
    else, through them, closes when the relay's later message names its ticket.
    """
    rules = rules or {}
    msgs = sorted((m for m in messages if m.get("id")), key=lambda m: _at(m.get("at", "")))
    adopt_ids(questions)
    by_id = {q["id"]: q for q in questions if q.get("id")}
    by_message = {}
    for q in questions:
        by_message.setdefault(message_id_of(q), []).append(q)
    added = closed = 0

    for m in msgs:
        if m.get("from_name") != me or ignored(m, rules):
            continue
        if m["id"] in by_message:  # a message already in the list is never read again, nor re-split
            continue
        for q in questions_in(m):
            if q["id"] in by_id:
                continue
            sent = _sent_draft(questions, q)
            if sent is not None:  # a to_send question that has now been sent
                sent.update({k: q[k] for k in ("message_id", "chat_id", "asked_at", "url")})
                sent["status"] = "waiting" if sent.get("status") != "answered" else "answered"
                by_message.setdefault(q["message_id"], []).append(sent)
                continue
            questions.append(q)
            by_id[q["id"]] = q
            by_message.setdefault(q["message_id"], []).append(q)
            added += 1

    for m in msgs:
        if m.get("from_name") == me:
            continue
        for q in _answered_by(m, questions, by_message, relay):
            _close(q, m, "teams-quote" if message_id_of(q) in m.get("quotes", []) else "teams-reply")
            closed += 1

    if decided:
        for q in questions:
            if _open(q):
                for key in q.get("tickets", []):
                    hit = next(((d, t) for d, t in decided(key) if d >= q.get("asked_at", "")[:10]), None)
                    if hit:
                        q.update({"status": "answered", "answer": one_line(hit[1], 240), "answered_by": key,
                                  "answered_at": hit[0], "answer_source": "jira"})
                        closed += 1
                        break
    return {"added": added, "closed": closed}


def _open(q: Question) -> bool:
    return q.get("status") == "waiting" and not q.get("override")


def _sent_draft(questions: list[Question], q: Question) -> Question | None:
    for d in questions:
        if d.get("status") == "to_send" and not d.get("message_id") and d.get("text"):
            k = _key(d["text"])
            if k and k[:60] in _key(q.get("text", "")):
                return d
    return None


def _answered_by(m: Message, questions: list[Question], by_message: dict[str, list[Question]],
                 relay: str = "") -> list[Question]:
    at = _at(m.get("at", ""))
    quoted = [q for mid in m.get("quotes", []) for q in by_message.get(mid, [])]
    marked = [q for q in questions if q.get("id") in m.get("answers", []) or message_id_of(q) in m.get("answers", [])]
    same_chat = [q for q in questions if q.get("chat_id") and q.get("chat_id") == m.get("chat_id")
                 and _at(q.get("asked_at", "")) < at and q.get("to") and q.get("to") == m.get("from_name")]
    named = tickets_in(m.get("text") or text_of(m)[0])
    by_ticket = [q for q in same_chat if set(q.get("tickets", [])) & set(named)]
    if relay and m.get("from_name") == relay:  # asked of someone else, answered through the relay
        by_ticket += [q for q in questions if q.get("to") and q.get("to") != relay
                      and _at(q.get("asked_at", "")) < at and set(q.get("tickets", [])) & set(named)]
    found = [q for q in quoted + marked if _at(q.get("asked_at", "")) < at] + by_ticket  # one reply may answer several
    return [q for q in _unique(found) if _open(q)]


def _unique(qs: list[Question]) -> list[Question]:
    seen: set[int] = set()
    out = []
    for q in qs:
        if id(q) not in seen:
            seen.add(id(q))
            out.append(q)
    return out


def _close(q: Question, m: Message, source: str) -> None:
    text = m.get("gist") or one_line(text_of(m)[0], 240)
    q.update({"status": "answered", "answer": text, "answered_by": m.get("from_name", ""),
              "answered_at": m.get("at", ""), "answer_source": source, "answer_url": m.get("url", "")})


# ---------------------------------------------------------------- Jira "Decided" blocks

def adf_text(node: object) -> str:
    if isinstance(node, dict):
        if node.get("type") == "text":
            return str(node.get("text", ""))
        inner = "".join(adf_text(c) for c in node.get("content", []))
        return inner + ("\n" if node.get("type") in ("paragraph", "heading", "listItem") else "")
    if isinstance(node, list):
        return "".join(adf_text(c) for c in node)
    return str(node or "")


def decided_blocks(text: str) -> list[tuple[str, str]]:
    return [(d, one_line(t, 240)) for d, t in DECIDED.findall(text)]


def jira_decided(client: object) -> Callable[[str], list[tuple[str, str]]]:
    cache: dict[str, list[tuple[str, str]]] = {}

    def look(key: str) -> list[tuple[str, str]]:
        if key not in cache:
            try:
                issue = client.request("GET", f"issue/{key}", params={"fields": "description,comment"})  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - a ticket we can't read closes nothing
                cache[key] = []
                return cache[key]
            f = issue.get("fields", {})
            text = adf_text(f.get("description"))
            text += "\n".join(adf_text(c.get("body")) for c in f.get("comment", {}).get("comments", []))
            cache[key] = decided_blocks(text)
        return cache[key]
    return look


# ---------------------------------------------------------------- files

def load(path: Path) -> dict:
    if not path.exists():
        return {"questions": []}
    data = json.loads(path.read_text())
    return data if isinstance(data, dict) else {"questions": data}


def save(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def day_slice(questions: list[Question], day: str) -> list[Question]:
    return [q for q in questions if (q.get("asked_at") or "")[:10] == day or (q.get("answered_at") or "")[:10] == day]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="daybook_collect.questions")
    sub = ap.add_subparsers(dest="cmd", required=True)
    mg = sub.add_parser("merge")
    mg.add_argument("inbox")
    mg.add_argument("--questions", default=None)
    mg.add_argument("--day-file", default=None)
    mg.add_argument("--jira", action="store_true")
    cur = sub.add_parser("cursor", help="print where the next fetch should start")
    cur.add_argument("--questions", default=None)
    args = ap.parse_args(argv)

    from .contract import load_config  # here, so the pure functions above import nothing
    cfg = load_config()
    qpath = Path(args.questions or cfg.get("questions_file") or f"{cfg['ledger_dir']}/questions.json").expanduser()
    data = load(qpath)

    if args.cmd == "cursor":
        print(data.get("scanned_until") or cfg.get("questions_since") or date.today().isoformat())
        return 0

    inbox = json.loads(Path(args.inbox).expanduser().read_text())
    rules = cfg.get("providers", {}).get("chat", {}).get("questions", {})
    decided = None
    if args.jira:
        from .contract import Context
        from .tickets.jira import make_client
        try:
            decided = jira_decided(make_client(Context(cfg=cfg, day=date.today())))
        except Exception as e:  # noqa: BLE001
            print(f"questions: Jira not checked ({e})", file=sys.stderr)
    counts = merge(data["questions"], inbox.get("messages", []), cfg.get("me", ""), rules, decided,
                   relay=cfg.get("reviewer", ""))
    if inbox.get("scanned_until") and inbox["scanned_until"] > (data.get("scanned_until") or ""):
        data["scanned_until"] = inbox["scanned_until"]
    save(qpath, data)

    if args.day_file:
        dpath = Path(args.day_file).expanduser()
        if dpath.exists():
            day = json.loads(dpath.read_text())
            day.setdefault("teams", {})["questions"] = day_slice(data["questions"], day.get("day", dpath.stem))
            save(dpath, day)
    waiting = sum(1 for q in data["questions"] if _open(q))
    print(json.dumps({**counts, "waiting": waiting, "scanned_until": data.get("scanned_until")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
