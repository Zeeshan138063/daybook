## 2. Chat: Microsoft Teams (Microsoft 365 connector, `chat_message_search`)

You fetch; a script decides what is a question and what answers it. Never write the questions file
yourself.

**a. Where to start.** `{{questions_command}} cursor` prints the time the last fetch reached
(SINCE). Fetch from SINCE's date to now. A date alone includes the whole day; messages already
seen are harmless, the script skips them by id.

**b. Search** (`chat_message_search`, `afterDateTime: <SINCE date>`, page with `nextOffset` until done):
- `query: "*"` with `sender` set to "{{me}}" (display name, never "me": the filter doesn't
  understand it), and to each name in `watch_people`;
- `query: "{{search_terms}} OR <each PR number>"`, `afterDateTime: <DAY>`, no sender (for notes).

**c. Read in full** with `read_resource` on its `uri`: every message from {{me}}, and every message
from someone else in a chat where {{me}} also wrote since SINCE. Search gives only summaries; the full
read gives the HTML body and the quote: an attachment with `contentType: "messageReference"` whose
`content` JSON holds the quoted `messageId`.

**d. Write the inbox** to `{{ledger_dir}}/inbox/teams-<YYYYMMDD-HHMMSS>.json` (make the folder):

```json
{"fetched_at": "<now, ISO>", "scanned_until": "<now, ISO>",
 "messages": [
   {"id": "<message id>", "chat_id": "<chatId>", "from_name": "<sender display name>",
    "to": "<for {{me}}'s messages: the other person in a one-to-one chat, else who it's addressed to>",
    "at": "<createdDateTime>", "html": "<body.content, as is>", "url": "<webUrl>",
    "quotes": ["<messageId of each messageReference>"],
    "topic": "<{{me}}'s message: a few words naming what it asks, with its ticket key>",
    "gist": "<someone else's message: the answer in one line>",
    "answers": ["<id of {{me}}'s message it answers, ONLY when it clearly answers one without quoting>"]}
 ]}
```

Leave `topic`, `gist` and `answers` out when unsure: the script has its own rules.

**e. Merge:**

```bash
{{questions_command}} merge <inbox file> --day-file {{ledger_dir}}/<DAY>.json --jira
```

It prints `{"added", "closed", "waiting", "scanned_until"}`. It also writes the day's questions into
the day file's `teams.questions`.

**f. Asks and notes** for the day file, as before:

```json
"teams": {
  "asks_for_me": [{"from": "...", "at": "...", "text": "<short>", "url": "..."}],
  "notes": [{"from": "...", "at": "...", "text": "<short>"}]
}
```

`asks_for_me` holds requests to {{owner_first}} still without a reply. Keep text short (one line);
keep no message text beyond what the outputs need. Keep `teams.questions` as the merge wrote it.
