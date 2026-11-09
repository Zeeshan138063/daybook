# Daybook v0.3.0: first public version

**Your working day, beside Claude Code.** One panel for what needs you, your PRs, tickets,
questions and time, gathered read-only from GitHub, Jira, Teams and Outlook.

## Highlights

- **The panel:** Needs you, Time (any weekday), Questions, Answered, Pull requests, Tickets, Board
  and Settings. Every card folds, and narrow panes drop columns.
- **Questions that close themselves:** each question is captured once, and closes when a reply
  quotes it, names its ticket, or a dated decision lands on the ticket. **Mark answered** and
  **Not a question** both have an undo.
- **`/daybook demo`:** a week of made-up data, for trying it out and for screenshots.
- **`/daybook doctor`:** one line per tool, with a ✔ or the exact fix.
- **`/daybook-setup`:** a few questions, then a working config, the gather agent and a health check.
- **Your buttons:** the action bar and timed runs come from your config.

## Install

```
/plugin marketplace add Zeeshan138063/daybook
/plugin install daybook@daybook
/daybook-setup
```

## Known limits

- Supported today: GitHub, Jira, Microsoft Teams and Outlook. GitLab, Linear, Slack, Gmail and
  Toggl are planned.
- Chat and calendar go through Claude connectors, so they fill in about a minute after **Refresh**.
- The panel's own tests need the Claude Code engine, so they run locally, not in CI.
