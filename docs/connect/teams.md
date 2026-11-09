# Microsoft Teams

> Tracks the questions you ask in chat and closes them when they're answered, lists asks aimed at
> you, and gives each question an **Open in Teams** link.

| 1. You need | 2. Connect | 3. Check |
|---|---|---|
| The Microsoft 365 connector in Claude, signed in with your work account | In Claude: Settings → Connectors → Microsoft 365 → Connect. Then run `/daybook-setup`, which finds the connector's tool names | Press **Refresh**, then `/daybook doctor` shows ✔ teams: reached by the agent's last run |

**In your config** (the tool names differ per account; setup fills them in):

```json
"chat": {
  "type": "teams", "via": "connector",
  "tools": ["mcp__<id>__chat_message_search", "mcp__<id>__read_resource", "mcp__<id>__get_me"],
  "search_terms": "PROJ OR release",
  "questions": { "ignore_prefixes": ["Ticket updates for today"] }
}
```

**Good to know**
- Only the gather agent can use connectors, so chat fills in a minute after **Refresh**, not instantly.
- After the agent's tools change, start a new Claude session.
- **Send in Teams** opens a chat with your question typed in. You press send; Daybook never does.

**Privacy:** the agent only searches and reads. It keeps one line per message, plus the inbox file
the questions merge reads, all on your machine.
