#!/bin/sh
# The questions list: questions.sh cursor | questions.sh merge <inbox.json> [...]
exec sh "$(dirname "$0")/run.sh" questions "$@"
