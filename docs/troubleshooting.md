# Troubleshooting

Start with `/daybook doctor` (or **Check connections** in Settings). Every ✘ line comes with its
fix. Here is what each one means.

| The doctor says | What to do |
|---|---|
| no config at … | Run `/daybook-setup` |
| … is not valid JSON (…, line N) | Fix that line, or run `/daybook-setup` again (your old file is kept as `.bak-<time>`) |
| config …: missing me, ledger_dir … | Run `/daybook-setup` |
| day files in … ✘ | `mkdir -p` that folder |
| GitHub CLI (gh) not found | `brew install gh`, then `gh auth login` |
| GitHub CLI is not signed in | `gh auth login` |
| owner/repo checked out at … ✘ | Clone the repo there, or fix `providers.code.repos` |
| Jira site not set | Set `providers.tickets.site`, e.g. `https://you.atlassian.net` |
| Jira not checked | Install the jira-agent plugin, or set `providers.tickets.email` and `token` (both as `{"env": …}`) |
| Jira …: 401 / 403 | `jira-agent auth login`, or check the token your config points to |
| gather agent not installed | `python3 scripts/install_agent.py` |
| teams: the agent lacks N tool(s) | `python3 scripts/install_agent.py`, then start a new Claude session |
| teams: no connector tools named | Run `/daybook-setup`, or list the tool names under `providers.chat.tools` |
| teams / outlook: not checked yet | Turn the Microsoft 365 connector on and sign it in, then press **Refresh** |

## Other things

- **The panel says "No day file yet".** Press **Refresh**. If it stays, run `/daybook doctor`.
- **Teams and Outlook show "checking…" for a long time.** The agent writes when it's done, and the
  panel picks it up within a minute. A new session is needed after the agent's tools change.
- **A question never closes.** If the answer didn't quote it or name its ticket, press **Mark
  answered**. If it was never a question, press **Not a question**. Both can be undone.
- **I want to show Daybook to someone.** `/daybook demo` fills the panel with made-up data, and
  `/daybook live` brings yours back.
