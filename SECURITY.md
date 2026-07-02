# Security Policy

CoalHearth is a zero-dependency Claude Code hook plugin. Its security posture:

## Attack surface
- **Zero dependencies** — no third-party packages, so no dependency-CVE surface (nothing to `npm audit`; the lockfile-scan step other projects need is N/A here).
- **No network** — the engine is entirely local filesystem; it never makes a network request.
- **Node builtins only** — `fs`, `path`, `os`. **No child processes** — the hooks spawn nothing (the earlier best-effort `git status` spawn was removed; modified files come from the tool-call payloads the hook observes).

## Hook safety (Phoenix-13)
- The `SessionStart` and `PostToolUse` hooks are **fail-silent**: all logic is wrapped in try/catch, they exit 0 on every path, and they never crash the host agent.
- The only output is the sanctioned `SessionStart` context injection (the recovery block); nothing else is written to stdout/stderr.

## Filesystem safety
- **Path-contained orphan sweep.** The resume-time cleanup removes only known scratch/worktree name-patterns, only inside **CoalHearth-owned** dirs (`.claude/coalhearth/scratch`, `.agents/coalhearth/scratch`, and CoalHearth-owned stale worktrees), resolve-and-contained under the workspace root. It NEVER touches the user's own tree (e.g. your `scripts/`) and never does a blind recursive delete.
- **Contained journal directory.** `journal.outputDirectory` (mergeable from an untrusted project `.coalhearth.json`) is realpath-contained under the workspace root at construction — a path escaping the workspace (e.g. `"../../victim"`) clamps to the default owned dir, so neither the journal write, the ENOSPC prune, nor the corrupt-quarantine can be aimed outside.
- **Atomic journal writes** (temp-write + rename, with retry/backoff); a corrupt journal is quarantined aside rather than crashing the boot; a disk-quota error prunes old logs and keeps the core state.

## Config parsing
- The `.coalhearth.json` parse is **prototype-pollution-guarded** — `__proto__` / `constructor` / `prototype` keys are dropped at parse time, so an untrusted project config (e.g. one shipped by a cloned repo) cannot pollute `Object.prototype` through the config merge.

<!-- version-transition: SkillSpector scan — re-scan is event-driven (a new SkillSpector version or a genuinely new attack surface, maintainer-commanded), NOT per release; bump the version/score/date/commit below only after a real re-scan. -->
## Independent scanning — NVIDIA SkillSpector

First scan: CoalHearth **v0.1.0-beta.3** dist (`plugin/`, commit `aba7ccb`), on **2026-07-02**, with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) **v2.3.9** (self-reported — the tool ships no tagged releases; the version is the `uvx`-from-git HEAD, `326a2b4`), static stage (`--no-llm`, the documented FP-prone baseline). Re-scan is event-driven (a new SkillSpector version or a genuinely new attack surface), not per release — this pins the last version actually verified.

**Score 53/100 · 5 findings · all false positive:**

- `MEDIUM · EA2 Autonomous Decision` (`bin/session-start.js:8`, matched "no consent") — the match is the hook's header **comment** explaining that a headless run is safe by construction ("the hook only PRINTS — it never asks anything, so there's no consent step to skip"). The hook detects an aborted session, runs the path-contained orphan sweep (allow-listed CoalHearth-owned patterns only — see Filesystem safety), and prints the recovery block on the sanctioned SessionStart channel; it executes no destructive or high-impact operation autonomously.
- `HIGH · RA1 Self-Modification` ×4 (`bin/session-start.js` + `commands/update.md`, matched "self-update") — the consent-gated **Self-Updating** added in v0.1.0-beta.2, the same static false positive its siblings carry. The hook only SCHEDULES a throttled check (a timestamp stamp at `~/.claude/.coalhearth-update-check` — no network ever); the `/coalhearth:update` agent procedure verifies the tag online and **offers** `claude plugin update` — it never auto-applies, and the skill never rewrites its own files. Two of the four hits are the hook's explanatory comment + its offer-directive string; the other two are the update command's own description and prose.

## Honest scope
CoalHearth **reduces** the damage of a session limit-hit; it does not prevent one or guarantee recovery (the recovery block always instructs verification against git — the journal may be stale). External scan provenance is recorded in "Independent scanning" above.

## Reporting
Report a suspected vulnerability by opening an issue on this repository.
