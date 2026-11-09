# How questions are tracked

Daybook keeps one list of the questions you ask in chat. Each question is recorded once, and it
closes on its own when the answer arrives.

## What counts as a question

A message from you, in a chat your config doesn't ignore, that is at least 20 characters long and:

- has a `?`, or says "needs your OK", or opens with "one question", "two questions" and the like;
- doesn't open with "FYI", and doesn't say "no answer needed".

When a message has a numbered list and two or more items are questions, each item becomes its own
entry (`<message id>#1`, `#2`, ...). If the opening line itself asks ("who should I send these
to?"), the list below it counts as content, and the whole message stays one question.

Ignore a standup group or status posts with `providers.chat.questions`:

```json
"questions": {
  "ignore_prefixes": ["Ticket updates for today"],
  "ignore_chats": ["19:standup-chat-id@thread.v2"]
}
```

## What closes it

Checked in this order, and a single reply can close several questions:

1. A reply that **quotes** the question (the chat gives the quoted message's id).
2. A reply the agent marked as **answering** it, for an answer that doesn't quote.
3. A later message from the person it was asked of, in the same chat, that **names one of its tickets**.
4. A question asked of someone else through your **reviewer**, when the reviewer's later message
   names its ticket.
5. A dated **"Decided (2026-11-07)"** or **"Decision (Sam, 2026-11-07)"** note on one of its tickets,
   on or after the day it was asked.
6. **Mark answered** in the panel.

## Your overrides

- **Mark answered** and **Not a question** are saved as an `override`, which the merge never changes.
- **Undo** (in Answered) and **Restore** (in "Hidden as not a question") remove the override, so
  the question goes back to what the rules say.

Nothing is ever deleted.
