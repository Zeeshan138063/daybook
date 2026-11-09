---
name: daybook-setup
description: Set up the Daybook panel for this person. Finds which of their tools are already connected (code host, ticket tracker, chat, mail), asks at most six short questions, writes the config, installs the gather agent and runs the doctor. Use for "set up daybook", "/daybook-setup", "connect my tools to daybook", or when the doctor says there is no config.
---

# Daybook setup

Everything here is local: the config file and the gather agent. Nothing is sent anywhere, no token
is ever asked for or written, and an existing config is kept as a `.bak-<time>` copy.

## 1. Find what is already connected

Look at your own tool list (do not ask the person what you can see):

| Category | Present when your tools include | Record |
|---|---|---|
| chat: teams | a tool ending in `chat_message_search` (Microsoft 365) | its full name, plus the same server's `read_resource` and `get_me` |
| chat: slack | a Slack connector's search or history tool | its full names |
| mail: outlook | a tool ending in `outlook_calendar_search` | its full name |
| mail: gmail | a Google Calendar or Gmail connector's search tool | its full names |

For the code host and tracker, run, read-only:

```bash
gh auth status 2>&1 | head -3
ls ~/.claude/plugins/cache/*/jira-agent 2>/dev/null | head -1
```

## 2. Ask (one AskUserQuestion call, at most four questions; then at most two more)

Use what step 1 found as the recommended option each time, so most people just confirm:
1. **Your name** as your team's tools show it (free text through "Other"), and who reviews your work.
2. **Repos:** the folders you work in. Offer the current folder first.
3. **Tracker:** Jira (then its site, like `you.atlassian.net`) or none.
4. **Chat and mail:** what step 1 found, or none.
Then, only if needed: the working day's range (default 7h 30m to 8h 30m).

Never ask for a password or token. If Jira is not reachable through jira-agent, tell them they can
set `JIRA_EMAIL` and `JIRA_API_TOKEN` in their shell (or the Keychain) themselves, and pass only the
variable name (`jira_token_env`).

## 3. Write and check

Write the answers to a temporary JSON file with these keys, then run the script:

```json
{"name": "...", "reviewer": "...", "repos": ["/abs/path"], "tickets": "jira|none",
 "jira_site": "...", "jira_project": "...", "chat": "teams|slack|none", "chat_tools": ["..."],
 "mail": "outlook|gmail|none", "mail_tools": ["..."], "day_min": "7h 30m", "day_max": "8h 30m"}
```

```bash
python3 "<this plugin's root>/scripts/setup.py" --answers <file>
```

It writes the config, installs the gather agent and prints the doctor's report. Show the report.
For each ✘, give its fix line as a step the person takes. Then:

- `/daybook` opens the panel; **Refresh** fills it.
- A new session is needed before the gather agent's new tools take effect.
- `/daybook demo` shows what a full day looks like, with made-up data.
