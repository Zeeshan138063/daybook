# GitHub

> Shows your pull requests, their review state and new comments, the tickets each one covers, and
> local commits not pushed yet.

| 1. You need | 2. Connect | 3. Check |
|---|---|---|
| The GitHub CLI (`gh`), and your repos checked out locally | `brew install gh`, then `gh auth login` | `/daybook doctor` shows ✔ GitHub signed in as you, and ✔ for each repo |

**In your config** (`/daybook-setup` writes this from your repo folders' `origin` remotes):

```json
"code": { "type": "github", "via": "cli", "repos": { "acme/app": "~/code/app" } }
```

**Privacy:** only reads (`gh pr list`, `gh api`), with `gh`'s own sign-in. No token is stored by Daybook.
