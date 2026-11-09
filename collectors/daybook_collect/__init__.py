"""Daybook collectors: read-only adapters that turn each tool's data into the day file.

One adapter per provider and category. The orchestrator (gather.py) picks the adapter the config
names for each category, runs it, and records the result under "sources". Adding a provider means
adding one module and one line in registry.py.
"""
