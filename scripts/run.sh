#!/bin/sh
# Run one collectors module (questions, doctor, ...) read-only on every service.
#   run.sh <module> [args]      e.g. run.sh doctor, run.sh questions cursor
# With jira-agent installed it runs in that environment, so Jira can be reached through its sign-in.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)"
module="$1"; shift
export PYTHONPATH="$here/collectors${PYTHONPATH:+:$PYTHONPATH}"
ja="$(ls "$HOME"/.claude/plugins/cache/team-plugins/jira-agent/*/bin/jira-agent 2>/dev/null | tail -1)"
if [ -n "$ja" ] && command -v uv >/dev/null 2>&1; then
  root="$(dirname "$(dirname "$ja")")"
  exec uv run --quiet --project "$root" python -m "daybook_collect.$module" "$@"
fi
exec python3 -m "daybook_collect.$module" "$@"
