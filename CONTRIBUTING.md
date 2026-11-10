# Contributing

Thank you for helping. The most useful contributions are new providers (GitLab, Linear, Slack,
Gmail, Toggl...) and fixes found in daily use.

## Set up

```bash
git clone https://github.com/Zeeshan138063/daybook && cd daybook
uvx --with pytest --with jsonschema pytest -q   # collectors, setup, doctor, questions
claude plugin test .                             # the panel
npx -y -p typescript tsc -p .                    # types
sh scripts/privacy-check.sh                      # no personal data, no secrets
```

## Add a provider

1. An adapter in `collectors/daybook_collect/<category>/<name>.py` that implements the Protocol in
   `contract.py` (`gather(ctx) -> dict`), read-only.
2. One line in `registry.py`.
3. The type in `schema/config.schema.json`.
4. Tests with the tool stubbed (no network in tests).
5. For a chat or mail tool reached through a Claude connector: a section in `agent-templates/sections/`.

## Rules

- Read-only on every service. Anything that writes belongs in a command the user runs, after a yes.
- No real names, emails, company names or tokens anywhere, including tests: use Alex Example,
  Sam Reviewer, PROJ-123 and example.com. The privacy check enforces it.
- Keep a change small and add a line to `CHANGELOG.md`.
