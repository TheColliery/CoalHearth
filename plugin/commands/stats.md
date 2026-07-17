---
description: CoalHearth stats — journal activity and resume events this session
---

Produce the CoalHearth stats report for this session, in the user's language. Tables only, minimal prose.

Read the CURRENT session's journal (the `.claude/coalhearth/session_handoff.json` under this project, if present) plus the conversation context, and show:
- **Journal state:** last-update timestamp, modified-files count, in-flight subagents recorded, checklist/goal captured or N/A.
- **Resume events:** whether this session STARTED from a recovery block (warm resume) — and if so, what it carried (files, sub-flight records) and whether the snapshot matched reality.

Honest empty state: no journal file and no resume this session → say exactly that in one line.

This is the measurement standard-system command. Read-only — do not modify any file.
