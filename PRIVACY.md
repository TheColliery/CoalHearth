# CoalHearth Privacy Policy

**CoalHearth collects nothing and phones nowhere.**

- **No telemetry.** No usage data, analytics, or identifiers are collected, stored, or transmitted — by either hook or any bundled component.
- **No network calls from the hooks.** Both hooks are offline by design (Phoenix Commandment #7): they read local files, journal locally, and print only on their sanctioned channel. No sockets, no requests. (The self-update *check* is the agent's `/coalhearth:update` procedure, run only with your consent — never the hook.)
- **It runs inside YOUR agent.** CoalHearth operates no servers and receives no traffic. It calls no model API; everything happens in your Claude Code session, on your account, under your platform's permission gate.
- **The journal is a snapshot of YOUR session, kept on YOUR disk.** It records the goal, checklist, planned steps, and modified-file *names* (read best-effort from `task.md` / `git status`) — never uploaded anywhere. The budget figures are a local char-count estimate, advisory only, not a platform-verified read.
- **Error reports are manual.** When something misbehaves, your agent may *offer* to open a pre-filled GitHub issue; nothing is submitted automatically, and you see and edit the full contents first.
- **Local files only.** All state lives in files you can read: the journal `<project>/.claude/coalhearth/session_handoff.json` (a corrupt journal is quarantined aside as `session_handoff.corrupt.json` in the same directory), the config (`~/.claude/.coalhearth.json` global, plus an optional per-project `.coalhearth.json`), and the self-update throttle stamp `~/.claude/.coalhearth-update-check` (a timestamp, nothing more).

Questions: open an issue at <https://github.com/TheColliery/CoalHearth/issues>.
