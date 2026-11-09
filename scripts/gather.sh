#!/bin/sh
# Refresh the day file's code and ticket parts (read-only). Usage: gather.sh [YYYY-MM-DD]
exec sh "$(dirname "$0")/run.sh" gather ${1:+--day "$1"}
