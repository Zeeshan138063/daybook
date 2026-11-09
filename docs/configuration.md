# Configuration

One JSON file: `~/.claude/daybook/config.json` (or wherever `DAYBOOK_CONFIG` points).
`/daybook-setup` writes it for you, and `schema/config.schema.json` validates it. **Secrets never
go in this file:** a token is named by where it lives (`{"env": "JIRA_API_TOKEN"}` or
`{"keychain": "jira-token"}`).

## You

| Key | What it is | Example |
|---|---|---|
| `me` | Your name as your tools show it | `"Alex Example"` |
| `call_me` | The name the greeting uses | `"Alex"` |
| `reviewer` | Who reviews your work | `"Sam Reviewer"` |
| `watch_people` | People whose chat messages are read | `["Sam Reviewer"]` |
| `people` | Name to email, for the **Send in Teams** link | `{"Sam Reviewer": "sam@example.com"}` |

## Your day

| Key | What it is | Example |
|---|---|---|
| `day_min_minutes`, `day_max_minutes` | The range a working day should land in | `450`, `510` |
| `ledger_dir` | Where the day files go | `"~/daybook-ledger"` |
| `ledger_keep_days` | Day files older than this are pruned | `60` |
| `questions_file` | The questions list | default `<ledger_dir>/questions.json` |
| `questions_since` | Where the first chat read starts | `"2026-11-01"` |

## Your tools (`providers`)

| Part | `type` today | Also accepted by the schema (adapters welcome) |
|---|---|---|
| `code` | `github` | `gitlab`, `bitbucket`, `none` |
| `tickets` | `jira` | `linear`, `github_issues`, `gitlab_issues`, `none` |
| `chat` | `teams` | `slack`, `none` |
| `mail` | `outlook` | `gmail`, `none` |
| `time` | `jira_worklogs` | `tempo`, `toggl`, `harvest`, `none` |

Each provider takes:
- `via`: `cli`, `api` or `connector`;
- `site`;
- `url_template`: a ticket's link, with `{site}`, `{key}` and `{number}` filled in;
- `search_url_template`: several tickets at once, with `{keys}`;
- `token`: where the token lives, never the token itself.

Chat and mail also take `tools`, the connector tool names the gather agent may use. Chat also
takes `search_terms` and `compose_url`.

## Buttons and timed runs

The action bar is empty until you add commands you have (usually your own skills):

```json
"actions": {
  "primary": { "label": "Propose timesheet", "command": "/timesheet" },
  "buttons": [
    { "label": "Draft status", "command": "/status", "hint": "for {reviewer}" },
    { "label": "Start ticket", "command": "/start", "hint": "next {next_ticket}" }
  ],
  "time_short": "/timesheet"
},
"schedule": [{ "at": "09:00", "commands": ["/standup"] }],
"refresh_command": "/daybook-refresh"
```

- In `hint`, `{reviewer}` is filled in, and `{next_ticket}` becomes a link to that ticket.
- `schedule` runs each command once a working day, within 30 minutes of `at`, and never at weekends.
- `refresh_command` is what **Refresh** runs after the code and ticket gather. It defaults to
  `/daybook-refresh` when chat or mail is set.

## Looks

`ui.accent` is the panel's accent colour, e.g. `"#0f9d8a"`.
