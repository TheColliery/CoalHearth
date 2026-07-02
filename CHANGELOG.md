# Changelog

All notable changes to CoalHearth are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer (the canonical version lives in `.claude-plugin/plugin.json`).

## [0.1.0-beta.7] — 2026-07-02

### Fixed
- **`mergeModifiedFiles` (state-snapshot) now realpath-resolves BOTH the workspace root and the touched file before relativizing.** On macOS `process.cwd()` returns the physical `/private/var/...` path while a tool payload's `file_path` is often the raw `/var/...` symlink, so the lexical `path.relative` spuriously started with `..` and stored the file as an absolute path instead of the clean relative one — beta.6's payload-derived `modifiedFiles` test failed on `macos-latest` (both Node lanes) for exactly this. realpath falls back through the file's existing parent dir (a half-applied edit may not be on disk yet), then the lexical path; never throws (Phoenix #4). Same realpath-both-sides class as the beta.5 stop-at-home fix — caught by the first CI run on macOS.

## [0.1.0-beta.6] — 2026-07-02

**Three MED fixes from the round-2 CoalBoard audit (both boards)** — the PostToolUse hook is now truly spawn-free (Phoenix #5), the dead turn-budget path is gone, and the journal directory can no longer be aimed outside the workspace by an untrusted config.

### Fixed
- **MED — Phoenix #5 violation: the PostToolUse hook spawned `git status` on EVERY tool call** (`lib/state-snapshot.js`). "Never spawn child processes" is absolute for Phoenix-13 hooks; the spawn also cost per-call latency on big repos and parsed `--porcelain` without `-z`. Removed entirely — `modifiedFiles` now **accumulates from the file paths the hook itself observes** in `Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool payloads (prior journal list + the current call's file, deduped, relativized under the workspace), which is a *more* accurate "what changed this session" than `git status` (that also lists pre-session dirt) and needs no child process at all. `HandoffJournal` gained a fail-silent `load()` for the accumulation read-back. Both hooks are now spawn-free; README/SECURITY updated to say so without the old `git status` carve-out.
- **MED — the turn-budget path was structurally dead** (`lib/budget-tracker.js`). The hook constructs a fresh `BudgetTracker` each PostToolUse (Phoenix #6, stateless — nothing persists a turn count), so `currentTurns` never exceeded 1 and the turn nudge could not fire unless `maxTurns <= warningTurnThreshold + 1`. YAGNI-removed: the tracker is **token-only** (the token branch CAN fire, on a large single payload); `maxTurns` + `warningTurnThreshold` are removed from `scripts/lib/config-schema.mjs` (tombstoned — do not re-add without a persistence design), `config/schema.json`, the factory config, and the README table.
- **MED — `journal.outputDirectory` escaped the workspace (REPRODUCED)** (`lib/handoff-journal.js`, `lib/resume-engine.js`, new `lib/contained-dir.js`). The constructors anchored to the raw config value, so an untrusted project `.coalhearth.json` `{"journal":{"outputDirectory":"../../victim"}}` made `save()` WRITE and the ENOSPC prune DELETE in an arbitrary directory outside the workspace — the beta.4 prune containment only contained *within* that attacker-supplied dir. The output dir is now **realpath-contained under the workspace root at construction** (shared `containedOutputDir`, realpath BOTH sides, fail-closed on unresolvable): an escaping path clamps to the default owned dir; if even the default cannot be contained, the journal/resume no-op. Covers every write path through it — the journal save, the ENOSPC prune, the corrupt-quarantine, and the mark-resumed write. Regression tests: an escaping `outputDirectory` writes nothing and prunes nothing outside; both classes clamp.

Gate: build + verify + 91/91 tests PASS (84 + 7 new regression tests; the case-9 hermetic hook test converted from git-derived to payload-derived).

## [0.1.0-beta.5] — 2026-07-02

**The stop-at-home config walk is now symlink-correct (realpath both sides)** — the series one-flock sweep; same class as CoalFace v0.1.0-beta.2, which proved the bug live on macOS CI.

### Fixed
- **`findProjectRoot` compared lexical paths, so the stop-at-home guard never fired under a symlinked home** (`lib/load-config.js`, `scripts/lib/config-load.mjs`). On macOS, `process.cwd()` returns the physical `/private/var/...` path while `os.homedir()` returns the raw `/var/...` symlink — the lexical `dir === homeAbs` NEVER matched, the walk escaped above home, and a `.coalhearth.json` above home could be read as project config. Both sides now resolve through `realpathSync` (fail-open to a lexical resolve when the path has no realpath) before comparing — the same realpath-and-contain discipline `sweepOrphans` (beta.3) and `_pruneOldLogs` (beta.4) already use, now applied to the config walk. Stop-at-home is unweakened; the walk stays lexical after the physical anchor. Test sandbox dirs are now realpath'd at creation so the suite asserts physical paths on every OS (CoalHearth's tests previously passed on macOS only by assertion luck — they never routed through `process.cwd()`).

Gate: build + verify + 84/84 tests PASS.

## [0.1.0-beta.4] — 2026-07-02

**Two HIGH fixes + a hot-path MED + config de-rot** — surfaced by two independent CoalBoard nasa audits (fable/nasa + haiku/nasa mirrors) running the code, not asserting. No change to the recovery core's happy path.

### Fixed
- **HIGH — `\Z` silently dropped constraints on resume** (`lib/state-snapshot.js`). `parseConstraints` used `(?=^##\s|\Z)`; JS regex has no `\Z` anchor — it matched a literal "Z". When `## Constraints` / `## Working Rules` was the LAST section of `AGENTS.md` (the common layout) with no literal "Z" after it, the lazy body found no stop point and the whole match failed → constraints silently `[]`, so the resumed agent lost its standing rules. Replaced with `(?![\s\S])` (true end-of-input; flag-independent). Regression test: an `AGENTS.md` that ENDS on the Constraints list.
- **HIGH — `_pruneOldLogs` could blind-delete an untrusted-config-aimed dir** (`lib/handoff-journal.js`). The ENOSPC prune did `readdirSync` + `unlinkSync` on every entry except the journal — a blind delete-all with no path containment, and `outputDirectory` is merged from the untrusted project `.coalhearth.json`, so a poisoned `{"journal":{"outputDirectory":"../secrets"}}` + a disk-full save could delete every file in an attacker-chosen directory (and it nuked the `*.corrupt.json` forensic quarantine even in-bounds). Now an **allow-list** (`error.log`, `*.tmp` only) with the same **realpath-and-contain** discipline `resume-engine.js` `sweepOrphans` uses (physical realpath of root + every candidate, fail-closed on unresolvable). The journal AND the corrupt-quarantine are kept. Regression tests: the quarantine + unrecognized files survive; a dir outside the owned journal dir is never touched.
- **MED — `atomicityRetries` unclamped × synchronous busy-wait → PostToolUse stall** (`lib/handoff-journal.js`, `config/schema.json`). `save()` runs on the PostToolUse hot-path and its retry backoff is a synchronous spin, so a hostile `atomicityRetries: 50` spun the hook ~25.5s per tool call. Now clamped to **[1, 5]** at load (worst-case backoff ≈ 200ms) and bounded in the JSON schema (`maximum: 5`). Regression test: a huge configured retry count returns in < 1s.

### Changed
- **`recovery.autoInjectPrompt` + `recovery.stashUnsavedChanges` are now wired** (were inert config keys — audit L7). `autoInjectPrompt:false` suppresses the recovery-block injection (still detects + sweeps + marks resumed); `stashUnsavedChanges:false` drops the "consider `git stash`" advisory line from the recovery block (the hook still never stashes for you — Phoenix #5).

### Removed
- **`journal.historyLimit`** — assigned but never read (no journal-history rotation exists; the prune is need-driven, not count-driven). Dropped from the schema, factory config, and README (audit L8).

Gate: build + verify + 84/84 tests PASS (77 + 7 new regression tests).

## [0.1.0-beta.3] — 2026-07-02

**Security fix — the orphan sweep's containment is now PHYSICAL (realpath), not lexical.** Caught by the new CI's very first run (all 6 matrix cells red): `sweepOrphans`'s `contained()` used `path.resolve` + `path.relative` — lexical resolution that never dereferences symlinks — so a scratch dir **symlinked outside the workspace passed the guard** and the sweep could delete through the symlink into foreign territory.

### Fixed
- **`ResumeEngine.sweepOrphans` realpath-and-contain** — both the workspace root and every sweep candidate are `fs.realpathSync`-resolved before the containment check (root too, or macOS's `/private`-symlinked tmpdir would no-op legit sweeps); an unresolvable candidate (absent/broken link) is never touched (fail-closed). Fail-silent per Phoenix-13.
- **The symlink-escape test now actually runs everywhere** — the previous test created the symlink with type `'dir'` (EPERM on unprivileged Windows) and skipped via a bare `return` = a silent vacuous pass that hid the bug on the dev box; it now uses `'junction'` (unprivileged on Windows, ignored on POSIX) and skips **visibly** via `t.skip(...)` where a filesystem truly cannot link. Also removes the vestigial always-true `if (linked)` conditional CodeQL flagged.

Gate: build + verify + 77/77 tests PASS (the symlink test now executes for real locally).

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
