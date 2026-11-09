# Security

Daybook only reads. It never posts, comments, transitions a ticket or sends a message; the action
buttons start commands you configure yourself, and those ask before they write anything.

- **Secrets never go in the config.** A token is named by where it lives: an environment variable
  (`{"env": "JIRA_API_TOKEN"}`) or the macOS Keychain (`{"keychain": "jira-token"}`).
- **Your data stays on your machine:** the config, the day files and the questions list are local
  files. Nothing is sent to any server of ours; there is none.
- **Reporting a problem:** please open a private security advisory on this repository (Security,
  Report a vulnerability) rather than a public issue.
