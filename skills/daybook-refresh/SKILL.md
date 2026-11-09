---
name: daybook-refresh
description: Fill chat, mail and tests in today's Daybook day file with the daybook-gather agent. Started by the Daybook panel's Refresh after its shell gather. Read-only on every service.
---

# Daybook refresh (chat and mail)

The panel's Refresh already gathered code and tickets with a script. Chat and mail go through
connectors that only an agent can use, so:

1. Start the `daybook-gather` agent for today (local date) in the background, with this prompt:
   "Refresh the day file for <today>: chat, mail and tests, as your instructions say. Code and
   tickets were just gathered; keep them. Read-only on every service. Report briefly: sources, new
   answers, asks waiting on me."
2. Say in one line that it's running. When it reports, reply in at most three short lines: which
   sources were reached, any new answer to a question, any ask waiting on the person.

Never post, send or write to any service. Never read `.env*` files. Do not start a second agent if
one for today is already running in this session.
