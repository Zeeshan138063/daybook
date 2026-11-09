## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checks

- [ ] `uvx --with pytest --with jsonschema pytest -q` passes
- [ ] `claude plugin test .` passes (for panel changes)
- [ ] `sh scripts/privacy-check.sh` is clean: no real names, emails, company names or tokens
- [ ] A line in `CHANGELOG.md` under Unreleased
- [ ] Still read-only on every service
