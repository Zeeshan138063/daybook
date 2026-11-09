# Jira

> Shows your tickets in development and review, the time you logged today and this week, the
> project's board, and dated "Decided" notes that close questions.

| 1. You need | 2. Connect (pick one) | 3. Check |
|---|---|---|
| Your site, e.g. `you.atlassian.net` | **A.** The jira-agent plugin, then `jira-agent auth login`. **B.** An [API token](https://id.atlassian.com/manage-profile/security/api-tokens) kept in your shell: `export JIRA_EMAIL=… JIRA_API_TOKEN=…` (or in the Keychain) | `/daybook doctor` shows ✔ Jira … signed in as you |

**In your config** (option B names the variables, never the values):

```json
"tickets": {
  "type": "jira", "via": "api", "site": "https://you.atlassian.net",
  "url_template": "{site}/browse/{key}",
  "email": { "env": "JIRA_EMAIL" }, "token": { "env": "JIRA_API_TOKEN" }
},
"time": { "type": "jira_worklogs" }
```

**The Board card (optional):** add `board` inside `tickets`. `areas` groups tickets by words in the
parent ticket's summary:

```json
"tickets": { "...": "...", "board": { "jql": "project = PROJ", "areas": { "frontend": ["UI"] }, "default_area": "backend" } }
```

**Privacy:** only GET requests (search, issue, worklog). It never transitions a ticket or logs time.
