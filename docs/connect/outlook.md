# Outlook calendar

> Shows today's meetings: their time, organiser, and any ticket keys in the title.

| 1. You need | 2. Connect | 3. Check |
|---|---|---|
| The Microsoft 365 connector in Claude (the same one as Teams) | In Claude: Settings → Connectors → Microsoft 365 → Connect, then `/daybook-setup` | Press **Refresh**, then `/daybook doctor` shows ✔ outlook: reached by the agent's last run |

**In your config:**

```json
"mail": { "type": "outlook", "via": "connector", "tools": ["mcp__<id>__outlook_calendar_search"] }
```

**Privacy:** calendar search only. Mail bodies are not read.
