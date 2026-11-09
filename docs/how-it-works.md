# How Daybook works

Daybook has three parts:
- a **panel** that draws your day;
- **collectors** that gather it, read-only;
- a few **local files** that hold it.

Nothing runs on a server, and nothing writes to your tools.

## Architecture

```mermaid
flowchart TB
  subgraph claude[Claude Code]
    PANEL[Daybook panel<br/>hooks/register.tsx]
    AGENT[daybook-gather agent<br/>chat and mail through connectors]
    SKILLS["/daybook-setup, /daybook-refresh<br/>and your own commands"]
  end
  subgraph local[Your machine]
    GATHER[collectors/daybook_collect<br/>gather.py · doctor.py · questions.py]
    DAY[(day files<br/>~/daybook-ledger/DATE.json)]
    Q[(questions.json)]
    CFG[(config.json)]
  end
  subgraph tools[Your tools, read-only]
    GH[GitHub · git]
    JI[Jira]
    TE[Teams]
    OU[Outlook]
  end
  GH & JI --> GATHER --> DAY
  TE & OU --> AGENT --> DAY
  AGENT -->|chat inbox| GATHER --> Q
  CFG --> GATHER & PANEL & AGENT
  DAY & Q --> PANEL
  PANEL -->|buttons you configure| SKILLS
```

| Part | Where | What it does | Why it's built this way |
|---|---|---|---|
| Panel | `hooks/register.tsx` | Reads the day file and questions, and draws the cards. It re-reads every minute | A Claude Code mod sits beside the chat, so there's no browser tab to keep open |
| Collectors | `collectors/daybook_collect/` | One adapter per tool behind one contract (`contract.py`), chosen in `registry.py` | Ports and adapters: adding a tool means adding one file, and the panel never changes |
| Gather agent | `agents/daybook-gather.template.md` | Reads chat and calendar through Claude connectors, which only an agent can reach | Its tool list is exactly the connectors your config names, and nothing else |
| Questions merge | `collectors/daybook_collect/questions.py` | Decides what counts as a question and what answers it | These are tested rules in code, so the result never depends on a model's mood |
| Doctor | `collectors/daybook_collect/doctor.py` | Shows one line per tool: a ✔, or the exact fix | Turns "it doesn't work" into a command you can run |

## Data flow: one Refresh

```mermaid
sequenceDiagram
  actor You
  participant P as Panel
  participant G as gather.sh
  participant A as daybook-gather agent
  participant M as questions merge
  participant F as day file + questions.json
  You->>P: Refresh
  P->>G: run (code, git, tickets)
  G->>F: write github, git, jira sections
  P->>A: /daybook-refresh (chat, mail)
  A->>A: read chat since the cursor, calendar for today
  A->>M: inbox file
  M->>F: new questions, closed answers, cursor moved
  A->>F: teams and outlook sections
  P->>F: re-read every minute
  P-->>You: cards update
```

## Data model

```mermaid
erDiagram
  DAY_FILE ||--o{ PR : "github.prs"
  DAY_FILE ||--o{ TICKET : "jira.tickets"
  DAY_FILE ||--o{ BOARD_ROW : "jira.board"
  DAY_FILE ||--o{ MEETING : "outlook.meetings"
  DAY_FILE ||--|| SOURCES : "sources"
  QUESTIONS ||--o{ QUESTION : "questions"
  TICKET ||--o{ WORKLOG : "worklogs_today"
  QUESTION }o--o{ TICKET : "tickets"
  QUESTION {
    string id "chat message id, #n per numbered item"
    string status "to_send | waiting | answered"
    string answer_source "teams-quote | teams-reply | jira | manual"
    object override "Mark answered / Not a question"
  }
  SOURCES {
    bool ok
    string at
    string error
  }
```

The full shapes are in `schema/day.schema.json`, `schema/questions.schema.json` and
`schema/config.schema.json`.
