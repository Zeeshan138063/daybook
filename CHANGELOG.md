# Changelog

All notable changes are listed here. Versions follow [semantic versioning](https://semver.org).

## Unreleased

- CI on every pull request: collector tests, lint, the privacy check and the schemas.
- Pull request and issue templates (bug, new provider).
- Documentation: a rebuilt README, How it works (architecture, data flow, data model), how questions
  are tracked, a card per tool to connect, every config key, and troubleshooting for each doctor
  message. Release notes for v0.3.0.

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
