# Changelog

All notable changes to CoalHearth are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer (the canonical version lives in `.claude-plugin/plugin.json`).

## [0.1.0-beta.1] — 2026-07-01

**Initial beta release.** A session warm-resume + advisory budget-guardrail engine for Claude Code — it reduces the work lost when a session hits a limit; it does not prevent the limit.

### Added
- **Recovery core** — `HandoffJournal` (atomic per-step journaling) + `ResumeEngine` (on boot, detect an interrupted session → inject a markdown recovery block that always tells the agent to verify against git, never blind-trust) + two Phoenix-13 hooks: `SessionStart` (resume) and `PostToolUse` (journal).
- **Budget guardrail (advisory)** — `BudgetTracker`, a best-effort char-heuristic turn/token estimate that emits one near-limit fan-out nudge. Explicitly advisory — a nudge, not a precise or guaranteed limit read.
- **Config** — `.coalhearth.json` (`budgets` / `journal` / `recovery`), schema-validated; the parse drops `__proto__` / `constructor` / `prototype` keys so an untrusted project config cannot pollute `Object.prototype` through the merge.
- **Safety** — zero-dependency (Node builtins only), no network, fail-silent hooks; the resume-time orphan sweep is path-contained and removes only CoalHearth-owned scratch artifacts (never the user's files, never a blind delete).
- **Tests** — 74 zero-dependency `node:test` cases, including hermetic simulations of all 11 limit-hit failure modes (main / worker death · locked / corrupt / disk-full journal · orphan sweep · stale journal · /compact · half-applied edits · no-user · orphan worktree).

Gate: build + verify + 74 tests PASS.
