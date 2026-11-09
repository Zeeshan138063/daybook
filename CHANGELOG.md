# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org).

## 0.3.0 (first public version)

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
