#!/bin/sh
# Fails if the repository holds anything personal: home paths, things that look like tokens, and
# every word you list in .privacy-words (gitignored, one extended regex per line: your name, your
# company, your ticket prefix, your Jira field ids, your connector ids). Run before every commit.
cd "$(dirname "$0")/.." || exit 2
pattern='/Users/[a-z]|/home/[a-z][a-z0-9_-]+/|ghp_[A-Za-z0-9]{20}|github_pat_|glpat-|xox[bpa]-|ATATT[A-Za-z0-9]{10}|lin_api_|sk-[A-Za-z0-9]{20}'
[ -f .privacy-words ] && pattern="$pattern|$(grep -v '^#' .privacy-words | paste -sd'|' -)"
[ -f .privacy-words ] || echo "privacy-check: no .privacy-words file, so only generic patterns are checked"
# Authorship is meant to carry a name: the licence's copyright line, the README's licence line and the
# plugin marketplace's owner. Nothing else may.
files=$(git ls-files -co --exclude-standard | grep -v '^scripts/privacy-check.sh$')
[ -n "$files" ] || { echo "privacy-check: no files found (is this a git repository?)"; exit 2; }
hits=$(echo "$files" | xargs grep -nIiE "$pattern" 2>/dev/null \
  | grep -vE '^(public/)?(LICENSE:[0-9]+:Copyright \(c\) [0-9]{4} |README\.md:[0-9]+:\[MIT\]\(LICENSE\) © [0-9]{4} |\.claude-plugin/marketplace\.json:[0-9]+:  "owner": \{ "name": )')
# .privacy-allow (gitignored, like .privacy-words): lines that may carry a listed word, such as
# the project's own repository address.
[ -f .privacy-allow ] && [ -n "$hits" ] && hits=$(echo "$hits" | grep -vE "$(grep -v '^#' .privacy-allow | paste -sd'|' -)")
if [ -n "$hits" ]; then echo "privacy-check: personal data found:"; echo "$hits"; exit 1; fi
echo "privacy-check: clean"
