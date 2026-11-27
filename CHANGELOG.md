# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org).

## 0.6.1

- The PR tracker's counts are its filter: press Open, Needs fixes or Merged to show just those;
  the one in use is highlighted. All shows everything.

## 0.6.0

- New: a **PR tracker** in the Pull requests card. One line says how many are open, how many need
  fixes, and how many merged lately. Pull requests are grouped by status: Needs fixes (reviewer
  comments newer than your last push), Blocked (conflicts, or stacked on one still open: "waits for
  API #623"), Back for review, In review, Approved, Draft, Merged.
- Filters on the card: Open, Merged or All; status; repository; search by number, ticket or title;
  and the merged window (7, 14 or 30 days). Copy summary gives the counts and a line per PR.
- `providers.code.account` names the gh account to read with, so the active account never decides
  whose pull requests are read.

## 0.5.0

- New: **How today is picked**, a screen in the Scrum card. Start from a preset (Most urgent first,
  My board order, Highest priority, Only what I queue), then switch rules on or off and move them up
  or down: unfinished from yesterday, already in progress, Next up, due soon (within N days),
  highest Jira priority, board order, and a custom Jira search under Advanced. "New tickets a day"
  caps the rest. Saved in `<ledger_dir>/scrum.json`; nobody edits a file.
- **Next up**: type ticket keys or numbers in the order you want them; a delivered one drops out.
- **Pick for today**: typed keys go straight onto today's list. ↑ ↓ under More reorder today.
- Each ticket on today's list says why it is there: carried, in progress, Next up #1, High · due
  27 Nov, board order, picked.
- The Jira collector adds each ticket's priority, your board's order, and the custom search.

## 0.4.2

- Blockers in the Scrum card's status line opens the list: every question still waiting, who it
  waits on, how long, and a link to its thread.

## 0.4.1

- The Scrum card is calmer: one status line in place of stat tiles; today as To do, In progress and
  Delivered with one action per ticket (Start or Done) and the rest under More; yesterday's marks as
  plain glyphs; the three oldest blockers with Show all.

## 0.4.0

- New: a Scrum card at the top of the panel.
  - **Yesterday's target:** each ticket you committed on the last planned day, its status then and
    now, a mark (delivered, in progress, not started) and "N of M delivered". Unfinished tickets
    carry over to today with one press.
  - **Today:** a suggested list (yesterday's unfinished tickets, yours in progress, the next two to
    do) that you edit and lock. Each row has Start (To Do → In Development, sets the start date)
    and Done (In Development → In Review, sets the due date). Each move shows a dry run first and
    writes to the tracker only after Confirm. Done warns when no PR names the ticket.
  - **Not done** keeps a reason; **Blockers** lists the questions still waiting; **Copy scrum**
    gives Done last, Today and Blockers as bullets.
- The plan is kept in `<ledger_dir>/scrum.json`; every write is logged in `<ledger_dir>/moves.log`.
- The Jira collector adds `jira.mine`: open tickets assigned to you, plus the last week's planned ones.

## 0.3.2

- Fix: the Time card's ticket bars no longer run past the card. Each bar shrinks to the room left,
  its time is drawn beside it as text, and in a narrow pane the list moves under the ring.

## 0.3.1

- Fix: the gather agent's templates moved from `agents/` to `agent-templates/`. Claude Code loads
  every file in a plugin's `agents/` folder as an agent, so an installed Daybook showed unfilled
  template agents (`{{owner}}`) beside the real one.
- The README tour is a walkthrough of the panel in use; five screenshots, all demo data.

## 0.3.0 (first public version)

- CI on every pull request: collector tests, lint, the privacy check and the schemas.
- Pull request and issue templates (bug, new provider).
- Documentation: a rebuilt README, How it works (architecture, data flow, data model), how questions
  are tracked, a card per tool to connect, every config key, and troubleshooting for each doctor
  message. Release notes for v0.3.0.
- The panel: Needs you, Time (day and week, any weekday), Questions, Answered, Pull requests,
  Tickets, Board (filters, search, pages), Settings. Every card folds.
- Providers: GitHub and local git for code, Jira for tickets and time, Microsoft Teams for chat and
  Outlook for the calendar (through Claude connectors).
- Questions you ask in chat are captured once, by message id, and close when a reply quotes them,
  names their ticket, or a dated decision lands on the ticket. Mark answered and Not a question,
  each with Undo.
- `/daybook demo`: a week of made-up data, nothing read, written or run.
- `/daybook doctor` and Check connections: one line per tool, a tick or the exact fix.
- `/daybook-setup`: a few questions, a working config, the gather agent installed.
- The action bar and timed runs come from your config.
