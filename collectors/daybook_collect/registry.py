"""Which adapter serves which provider type. Add a provider here and in its category folder."""

from __future__ import annotations

from .code.git_local import LocalGit
from .code.github import GitHubCode
from .tickets.jira import JiraTickets

CODE = {"github": GitHubCode}
TICKETS = {"jira": JiraTickets}
# Filled by the gather agent through Claude connectors, not by this script.
CONNECTOR_ONLY = {"chat": {"teams", "slack"}, "mail": {"outlook", "gmail"}}
LOCAL_GIT = LocalGit
