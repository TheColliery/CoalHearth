# Changelog

All notable changes to CoalHearth are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer (the canonical version lives in `.claude-plugin/plugin.json`).

## [0.1.0-beta.2] — 2026-07-02

**Skill-repo pattern conformance** — community docs, CI, self-update, zero-manifest. No change to the recovery core or the budget guardrail.

### Added
- **Self-update (kind-1, series-standard)** — the `SessionStart` hook now *schedules* a periodic check via a crash-safe throttle stamp (`~/.claude/.coalhearth-update-check`; no network, Phoenix #7); the *agent* verifies the latest tag and offers `claude plugin update coalhearth@coalhearth`, consent-gated. New config group `update`: `updateMode` (`ask`/`auto`/`remind`/`off`, default `ask`) + `updateCheckDays` (1-365, default 14, clamped on read). New `/coalhearth:update` command; `commands/` now ships in the plugin dist. Three new hermetic hook cases (stamp-throttle · `off` silent · `updateCheckDays:0` clamp).
- **`.github/`** — 4 SHA-pinned workflows (CI gate on 3 OS × Node 22/24 · CodeQL · markdownlint · Scorecard), `dependabot.yml`, and issue templates whose version placeholder carries a `version-pin:` marker gated by a new `verify.mjs` check (pre-release-aware).
- **Community docs** — `CONTRIBUTING.md`, `PRIVACY.md`, `.markdownlint.json` (per the series doc pattern).

### Removed
- **`package.json`** — zero-dependency needs no manifest (siblings ship none); the gates run directly: `node scripts/build-plugin.mjs` · `node scripts/verify.mjs` · `node scripts/test.mjs`.

Gate: build + verify + 77 tests PASS.

## [0.1.0-beta.1] — 2026-07-01

**Initial beta release.** A session warm-resume + advisory budget-guardrail engine for Claude Code — it reduces the work lost when a session hits a limit; it does not prevent the limit.

### Added
- **Recovery core** — `HandoffJournal` (atomic per-step journaling) + `ResumeEngine` (on boot, detect an interrupted session → inject a markdown recovery block that always tells the agent to verify against git, never blind-trust) + two Phoenix-13 hooks: `SessionStart` (resume) and `PostToolUse` (journal).
- **Budget guardrail (advisory)** — `BudgetTracker`, a best-effort char-heuristic turn/token estimate that emits one near-limit fan-out nudge. Explicitly advisory — a nudge, not a precise or guaranteed limit read.
- **Config** — `.coalhearth.json` (`budgets` / `journal` / `recovery`), schema-validated; the parse drops `__proto__` / `constructor` / `prototype` keys so an untrusted project config cannot pollute `Object.prototype` through the merge.
- **Safety** — zero-dependency (Node builtins only), no network, fail-silent hooks; the resume-time orphan sweep is path-contained and removes only CoalHearth-owned scratch artifacts (never the user's files, never a blind delete).
- **Tests** — 74 zero-dependency `node:test` cases, including hermetic simulations of all 11 limit-hit failure modes (main / worker death · locked / corrupt / disk-full journal · orphan sweep · stale journal · /compact · half-applied edits · no-user · orphan worktree).

Gate: build + verify + 74 tests PASS.
