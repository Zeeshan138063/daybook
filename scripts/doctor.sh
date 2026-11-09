#!/bin/sh
# Is every tool connected? One line per check, a tick or the exact fix. Read-only.
exec sh "$(dirname "$0")/run.sh" doctor "$@"
