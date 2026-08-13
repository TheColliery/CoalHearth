# Changelog

All notable changes to CoalHearth are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer (the canonical version lives in `.claude-plugin/plugin.json`).

## [2.3.0] - 2026-08-13

**MINOR** — board #94, upstream issue #13: subagent-death visibility. New backward-compatible capability (a new `UserPromptSubmit` hook + two enriched fields on an existing journal record) — see scripts-quality.md §3's decisive test.

### Added
- **`inFlightAgents` records `status` + `outcome` at resolution**, not just a name. `PostToolUse` fires exactly once per `Agent`/`Task`/`Workflow` spawn call, AT resolution (success or failure) — `lib/journal-step.js`'s `deriveStatus`/`deriveOutcome` now read `tool_response` instead of discarding it: `status` is `'completed'` / `'failed'` / `'unknown'` (a small vocabulary match against `resp.status`, never assumed from absence — an unrecognized or missing status reads `'unknown'`, not `'completed'`, because the reported incident's own second subagent said `status: failed` while having actually finished); `outcome` is a best-effort, 300-char-capped snippet probed from `resp.error`/`summary`/`message`/`result`/`output`/`text` — the "7 of 11 checks done" line a revive-or-defer decision actually needs. Reaches every platform this room ships (Claude Code + Antigravity + the 5 config-only ports) — the capture lives in the ONE shared `extractSpawn`, not a per-platform fork.
- **New `UserPromptSubmit` hook** ([`bin/user-prompt-submit.js`](bin/user-prompt-submit.js), **Claude Code only**): surfaces an unsurfaced RESOLVED subagent (`status` completed/failed) on the sanctioned UserPromptSubmit context-injection channel (hooks-safety.md Phoenix #13) — the user's very next prompt in the SAME session, not a session restart. Marks each surfaced entry `surfaced: true` under the same lock `PostToolUse` uses (H1), so the same resolution never nudges twice. The nudge text always states the caveat: a reported `status` is self-reported and has been observed wrong.
- **`ResumeEngine.generateHandoffPrompt`** renders `status`/`outcome` per subagent in the "In-flight subagents" section, plus a caveat line (present only when there is a subagent to caveat about): verify liveness before deciding to re-dispatch or discard; resuming is cheap (issue #13's own incident: 2 tool calls) — try it before waiting on a stated reset time.

### Honest scope, unchanged
- This does **not** detect a subagent whose tool call has never resolved at all (a true mid-dispatch death, or the harness itself dying before the call could resolve) — Claude Code's `PostToolUse` only fires AT resolution, and this room does not track a PENDING/dispatch-time record (no `PreToolUse` wiring). That class is still invisible until the next `SessionStart`. Named as a follow-up, not built here — a `PreToolUse`-based pending-tracker was scoped out: the operator's own issue ranked per-subagent progress capture (shipped above) as "likely sufficient by itself," and a pending-tracker needs an unverified tool-call correlation key (`tool_use_id`-family), doubling the hook surface for a case outside the reported incident.
- Cross-agent reach for the nudge specifically: **Claude Code only, this release.** Antigravity's `PreInvocation` fires per model call, not per tool call, so it cannot detect "a spawn just resolved" the way Claude Code's `UserPromptSubmit` can without restructuring the existing once-per-session guard — a decoupled AG variant is a named, unbuilt follow-up.

### Tests
- 1 new hermetic test in `bin/post-tool-use.test.js` exercising 4 status/outcome scenarios (failed/completed/unknown vocabulary, outcome capping).
- 7 new hermetic cases in the new `bin/user-prompt-submit.test.js` (silent-when-nothing-to-show, nudge-once-then-silent, multi-entry nudge, garbage stdin, corrupt journal).
- 1 new direct-call case in `scripts/lib/engine.test.mjs` (status/outcome rendering + the conditional caveat line).
- `t.after()`-registered cleanup throughout the new/touched test files (scripts-quality.md §2, board #107's own shape).

## [2.2.0] - 2026-08-08

**MINOR** — namespace campaign (#69+#39, owner-designated 2026-08-08): per-project `coalhearth.json` now lives under an agent dir, never bare at the project root. New backward-compatible capability (the legacy shape is still read; nothing is removed) — see scripts-quality.md §3's decisive test.

### Added
- **Per-project config read order**, identical wording in every room of this series: (1) `<project>/.<the running agent's OWN dir>/coal/coalhearth.json`; (2) other known agent dirs, fixed order `.claude` → `.agents` → `.gemini` (first found wins); (3) LEGACY `<project>/.coalhearth.json` at the project root — still read normally, no breakage for an existing config. `lib/load-config.js` and `scripts/lib/config-load.mjs` both gained `projectConfigCandidates`/a rewritten `projectConfigPath` (mirrored, same as always). `findProjectRoot`'s root-marker detection widened alongside it (`.git` / the legacy dotfile / all three new per-agent-dir shapes) — additive only, verified with a real fixture that the walk can only stop nearer, never wider, than before.
- **Named divergence from the campaign's own default framing** (CoalWash's shipped exemplar, `f9aff3b`, collapses "own dir" onto `.claude` because it activates only through Claude Code): CoalHearth does NOT collapse it. Unlike CoalWash, `loadConfig()` is called from multiple platform-specific entry points sharing this one codebase — `bin/session-start.js` (Claude Code) plus `bin/ag-pre-invocation.js` / `bin/ag-post-tool-use.js` (Antigravity, Gemini CLI, and 4 file-copy platforms, dispatched by the same argv mode). Hardcoding `.claude` would be wrong whenever the running agent is Gemini CLI or Antigravity — exactly the multi-agent scenario the design doc names (a project holding both `.claude/` and `.agents/`, e.g. this series' own umbrella repo). `ownDir` is now a caller-supplied parameter on `loadConfig`/`loadMergedConfig`; the AG-dispatch entry points pass it from their own mode detection, `bin/session-start.js` keeps the correct `.claude`-first default unchanged.
- **Update-check stamp relocated** (the #39 machine-global half) to `~/.claude/coal/coalhearth/update-check` (was `~/.claude/.coalhearth-update-check`), kept inline in `bin/session-start.js`'s `updateDue()` per hooks-safety.md's hook-logic-stays-inline discipline (not extracted to a lib) — CoalWash's shipped `updateStampPath`/`oldUpdateStampPath`/`readUpdateStamp`/`writeUpdateStamp` shape is the copy source. Read-new-fallback-old; write-new-drop-old (no-old-version-leftover).
- The GLOBAL config path (`~/.claude/.coalhearth.json`) is unchanged — only the per-project address and the update-check stamp move this round, matching CoalWash's own scope for this same campaign.

### Fixed
- 20 new tests: 3 read-order precedence cases × 2 mirrored files, a root-marker-widening regression × 2, a clamp-unchanged regression × 2 (the consent-cascade clamp on `update.updateMode`/`recovery.autoInjectPrompt` is unchanged regardless of which candidate address supplied the project value — only the file's ADDRESS moved), plus a stamp-relocation test in `scripts/lib/hooks.test.mjs` and two existing self-update hermetic cases updated to the new stamp path.



### Fixed
- **`parseConstraints` (`lib/state-snapshot.js`) silently dropped the ENTIRE Constraints/Working Rules section whenever the heading carried a punctuated suffix** — a parenthetical or a dash-note. The matching regex required the keyword to be the whole heading line (`\s*$` right after it); anything past that broke the anchor and the section matched nothing, so the resume snapshot's `activePlan.constraints` came back `[]` with no error. This is silent, not cosmetic: a heading like `## Working Rules (every session)` — TheColliery's own umbrella `AGENTS.md` uses exactly this shape — lost every rule bullet, and a resumed session had no way to tell "no constraints exist" from "constraints failed to parse." Any user whose `AGENTS.md`/project rules file uses a suffixed heading hit the same silent loss. This is a SECOND, always-present latent defect in the same regular expression, not a reintroduction of the beta.4 `\Z`-as-literal-Z regression (`lib/state-snapshot.js`'s own code comment) — `git log -S'Working Rules' -- lib/state-snapshot.js` returns exactly one commit, so the `\s*$` anchor was never removed and never came back; it simply went live the first time a heading gained a suffix. Widened to require, after the keyword, either end-of-line or a non-word/non-whitespace character (a lookahead, not a trailing `\b`) so a punctuated suffix — `"(every session)"`, `"— v2"` — is tolerated while a heading that only *mentions* the keyword ("## See Working Rules below") still correctly does not match.

  An earlier draft of this fix used a bare `\b` after the keyword, which under-covered: `text.match` is non-global, so a decoy heading that merely starts with the keyword and continues as an ordinary phrase ("## Constraints notes about foo") would win the first match and silently shadow a real "## Constraints" section further down — wrong content, no error, worse than the suffix bug it replaced. The lookahead closes that by requiring the character after the keyword (skipping whitespace) to be punctuation or end-of-line, not a second plain word.

  **Not fully general, and the residual is wider than "a suffix" implies — say so precisely rather than by example:** any heading of the shape *keyword + space + plain word*, with no punctuation separating them, still drops — `"## Constraints v2"`, `"## Constraints 2026"`, `"## Constraints and Guardrails"`, `"## Working Rules for contributors"` all silently return `[]`. A version tag or topic phrase written as a bare second word is, to this regex, indistinguishable from the decoy shape the lookahead exists to refuse. Two narrower residuals from before this fix are unchanged: a suffix with no separator at all (`"## Constraints_v2"`, `"## Working Rules2026"`) and a doubled space (`"## Working  Rules"`). None of these are regressions — the new accept-set is a strict superset of what the pre-fix `\s*$` anchor ever matched (verified across 28 heading shapes), so nothing that used to work now doesn't — and the failure is paid in the safe direction (an empty, visibly-suspicious `[]`, never wrong content), which is the point of narrowing the opener rather than ranking matches. One further residual, ASCII-only and left unfixed here: `\w` carries no `u` flag, so a non-ASCII second word passes where an ASCII one drops (`"## Working Rules ทุกเซสชัน"` matches, `"## Working Rules for agents"` does not) — a non-ASCII decoy could in principle still shadow a real section.

  Regression tests cover the suffixed-heading recovery case, the still-must-not-match mention case, a word-continuation heading, and a decoy-heading-before-the-real-section case.

## [2.1.1] - 2026-07-27

**PATCH** — the journal directory is no longer planted wherever a tool call's cwd happens to sit. Two commits on one branch: the root-anchor fix, then a station-3 review pass that found the anchor itself had a containment bug and one path it didn't yet cover.

### Security
- **The journal (`lib/contained-dir.js` `containedOutputDir`) no longer plants `.claude/coalhearth/` in whatever directory a hook's cwd happens to be.** The prior default (`root = process.cwd()`) treated ANY directory as a project — a tool call whose cwd sat in a project subdirectory (any `cd`, any subagent working deeper than the project root) got its own copy of the journal, right there. Live evidence: 26 such directories measured across one machine's working tree, 25 sharing a single session id, none at a real project root. The default now walks up from cwd to the nearest ancestor carrying a `.git` or the user's own `.coalhearth.json` (never past `$HOME`) and uses that as the anchor; finding neither by the time it reaches home, it returns `null` — no directory is created to stand in for a project that isn't there. A caller passing an explicit root (every existing test, and every legitimate advanced use) is unaffected. A `.git`-marked `$HOME` (dotfiles-as-a-repo) is a considered exception, not a miss: it anchors to home, which is already a Phoenix #10 sanctioned write root and one deterministic location rather than a proliferation of them.
- **The self-clean step that mops up a legacy phantom directory had its own containment bug: it could delete the journal directory it had just created.** Its "did drift happen" check compared a freshly-read `process.cwd()` against a value that had gone through `fs.realpathSync.native` — on any volume where a directory has more than one valid spelling (case-insensitive filesystems, an 8.3 short-name alias on Windows), those two disagree even when no drift occurred, so the mop-up fired on the ordinary case and unlinked the directory `containedOutputDir` had just created — measured, not theoretical: a mis-cased cwd left the hook writing no journal at all, and a legitimate pre-existing journal in that directory was deleted. Fixed by resolving `process.cwd()` once and reusing that single value on both sides of the comparison — a rule now stated in the code: both sides of a path equality must come from one resolution, never a fresh read compared against a realpath'd one.
- **The orphan sweep (`sweepOrphans`, the delete-capable cleanup a killed worker's leftovers route through) now anchors to the same project root as the journal write, not to raw `process.cwd()`.** The root-anchor fix above covered the write path but left the sweep on the old default in both the Claude Code and Antigravity hooks; after a cwd drift the two disagreed — the journal read from the correct project root while the sweep still looked in the subdirectory, so a killed worker's scratch files under the real project went uncollected. `sweepOrphans` now defaults to the same anchor-walk as the journal.
- **The journal directory now self-ignores: a local `.gitignore` (just `*`) is written inside `.claude/coalhearth/` so its contents never end up in your project's version control, even if your own `.gitignore` doesn't cover `.claude/`.** Ported from CoalWash's `ensureSelfIgnore` (its per-project write path only — CoalWash's own global-scope call, which writes directly into the shared `~/.claude`, was deliberately NOT ported). Self-ignore fires **only** for the default owned directory: a project-configured `journal.outputDirectory` never gets one, even a benign custom path, because that directory is not one CoalHearth exclusively owns. That scoping is an allowlist of one physically-resolved location, not a list of paths to avoid — a first cut here used a two-value lexical denylist and was reachable through a junction/symlink (a config value aliasing back to the project root would have planted a blanket `*` at the actual project root); fixed before release by comparing the same physically-resolved values the containment check already trusts.
- **Two config keys that gate an outward action can now only be QUIETENED by a project config, never escalated:** `update.updateMode` (the periodic self-update nudge) and `recovery.autoInjectPrompt` (the entire recovery-block injection — a multi-hundred-token spend plus an agent directive). A project `.coalhearth.json` arrives with whatever repo you clone and is untrusted; previously it could silently re-enable either one even after your global config turned it off. A user who has never written a global config is now treated as standing on the schema's own declared default (`ask` / `true`) when the clamp computes which side is quieter, rather than skipping the clamp entirely. `recovery.stashUnsavedChanges` (one advisory text line, no spend) stays plain project-wins, correctly out of scope. **Honest scope today: the self-update hook (`bin/session-start.js`) only branches on `updateMode === 'off'` — `ask`/`auto`/`remind` are byte-identical downstream — so this closes a conformance gap, not a currently-live escalation; it becomes a live protection the moment that hook starts distinguishing the three.**

### Changed
- Config merge semantics: `.coalhearth.json` is documented as "project wins" throughout, and still is for every key **except** the two named above.

### Fixed
- **6 remaining `fs.realpathSync` containment/prune calls (`lib/contained-dir.js`, `lib/handoff-journal.js`, `lib/resume-engine.js`) upgraded to `.realpathSync.native`**, conforming to `node/runtime.md` §4 (the plain variant does not expand a Windows 8.3 short name). Verified, not assumed, to be non-exploitable as shipped: every affected compare had BOTH sides on the plain variant, so a spelling mismatch there always over-refused (skip) rather than over-permitted. The upgrade also removes a `\\?\`-device-path degradation that could silently disable the orphan sweep.
- Doc comments left stale by the root-anchor change corrected: the `HandoffJournal`/`ResumeEngine` constructor `@param` notes no longer claim a `process.cwd()` default, and `journal-step.js`'s `cwd` parameter is now labelled as the state-snapshot read base, not the journal root.
- The legacy-phantom mop-up (`selfCleanLegacyPhantom`) now also removes the `.gitignore` self-ignore leaves behind, alongside the `session_handoff*` files it already cleaned — without it, a stray `.gitignore` from a past run left the directory permanently non-empty and the mop-up silently gave up every time.

## [2.1.0] - 2026-07-24

**MINOR** — two batches: transcript-GC recovery honesty (2026-07-22) and an Antigravity contract re-derivation (2026-07-23), plus close-out wording fixes left over from the v2.0.0 budget-guardrail removal.

### Added
- **Transcript-GC recovery honesty.** The journal now records the session's Claude Code transcript path (`bin/post-tool-use.js` / `bin/ag-post-tool-use.js` → `lib/journal-step.js` → `lib/state-snapshot.js`, set-or-omit exactly like `sessionId`), and `ResumeEngine.generateHandoffPrompt` (`lib/resume-engine.js`) `fs.statSync`s it on resume: a transcript CC has since garbage-collected (retention is version-dependent, not the guaranteed 30 days its docs imply — field-confirmed 2026-07-22, a ~4-day-old session was already gone) now flags "`claude --resume` is dead for this session" and, if CoalWash is installed, routes deeper recovery to its read-only `estate-search`/`estate-restore` (the CH×CW seam) — degrade-safe when CoalWash is absent, ENOENT-only so a stat glitch never false-cries GC'd. The preventive counterpart (archive the transcript into CoalWash's estate before CC's startup GC) was evaluated and **cut as over-engineering** (board 2026-07-22): CH recovers work-state from its own journal, and a lost transcript is re-derivable conversation history, not load-bearing work-state. +2 hermetic tests (`lib/state-snapshot.test.js`, `scripts/lib/engine.test.mjs`).

### Fixed
- **Antigravity adapters re-derived against the current PreInvocation/PostToolUse contract** (`bin/ag-pre-invocation.js`, `bin/ag-post-tool-use.js`; re-derived 2026-07-23 from the installed engine's own docs). Workspace resolution now reads `workspacePaths[0]` (the current spec's field) before the `cwd`/`Cwd` fallback; the once-per-session key and journal-owner stamp read `conversationId` before `session_id`/`sessionId`. Emit moves to the current output contract, `{"injectSteps":[{"ephemeralMessage":...}]}` — the pilot-era `{"additionalContext":...}` key is a **dead letter** in the shipped engine (0 hits) and is no longer emitted (no dual-emit: an unrecognized field can drop the whole protojson payload). `ephemeralMessage` (a transient system message) is the right step type for a recovery block. The shared assertion helper + session fixture in `bin/ag-hooks.test.js` now check the current shape; +2 new regression tests pin the full current-spec payload (`workspacePaths[]`/`conversationId`, no `cwd`/`session_id`) end to end → 133 total. Tier stays **wired** (hermetically tested against the spec; no live AG session has run either shape).
- **`plugin.json` (×2) + `marketplace.json` description/keywords still said "budget-guardrail"** — the guardrail was removed at v2.0.0. Wording corrected to "handover journal"; the `budget-guardrail` keyword replaced with `handoff-journal`.

### Changed
- README: the retention line drops the stale "early low-headroom nudge" mention (that nudge died with the budget guardrail at v2.0.0) and states the version-dependent-retention baseline plainly; the combined platform badge splits into one badge per platform (Gemini CLI / Copilot CLI / Devin CLI / Kiro / Augment); the AG "known limits" line now names `injectSteps`/`ephemeralMessage` instead of `additionalContext`.
- SECURITY.md's Antigravity emit-shape line, `platform-configs/hooks.json`, `platform-configs/hooks/README.md`, and `gemini-settings-hooks.json`'s comments all updated to reflect the `injectSteps` contract (Gemini's own nested `hookSpecificOutput.additionalContext` shape is untouched — that key belongs to Gemini's SessionStart, not AG's PreInvocation, and is still current).

## [2.0.2] - 2026-07-17

**PATCH** — CI-green fix-forward for v2.0.1 (macOS). Test-only; no shipped-code change.

### Fixed
- **The `sandbox()` test helper now realpath's its tmpdir dirs — fixes ROOT2/H3 on macOS.** On macOS `os.tmpdir()` is `/var` → `/private/var` (a symlink); a spawned hook's `process.cwd()` returns the resolved `/private/var` form, so the test's lexical `/var/...` file paths and the hook's physical cwd disagreed in `path.relative` (`mergeModifiedFiles`) → the journal stored absolute paths while ROOT2/H3 asserted relative. `sandbox()` now `fs.realpathSync`-resolves `home`/`cwd` at creation (no-op off macOS), matching the other six sandbox helpers in the repo (one-flock). The production hot-path stays lexical (realpath there breaks on not-yet-written files, per the series rule). Together with v2.0.1's read-only-fs fix, CI is green on all platforms.

## [2.0.1] - 2026-07-17

**PATCH** — CI-green fix-forward for v2.0.0. Test-only; no shipped-code change.

### Fixed
- **The read-only-journal regression test now simulates a true read-only fs on every platform.** v2.0.0 routed `markResumed` through the atomic writer (per-pid temp + rename); the test chmod-ed only the journal FILE `0o444`, which on POSIX `rename(2)` replaces needing only DIRECTORY write — so the temp renamed over the read-only file, the write succeeded, the "may repeat" honesty note never fired. The test was green on Windows (MoveFileEx refuses a read-only destination) but red on macOS/Linux. The test now also chmods the containing DIR `0o555` (fails the atomic temp-create on POSIX) and restores perms in `finally` — the honesty path is exercised on every platform, no skip. The v2.0.0 atomic `markResumed` is unchanged and correct: it legitimately succeeds when only the file, not the dir, is read-only.

## [2.0.0] - 2026-07-17

> **BREAKING (MAJOR): the `budgets` config group is removed.** A `.coalhearth.json` still carrying a `budgets` block is now ignored at runtime and flagged as an unknown group (non-crashing). Two batches from a blind adversarial crash-test (nasa-L3 audit follow-up): the dead budget guardrail retired, and five journal data-loss holes root-fixed.

### Removed
- **The advisory budget guardrail — removed rather than faked.** `BudgetTracker`, the `budgets.maxTokens` / `budgets.warningTokenPercentage` config group, the PostToolUse "prefer inline" nudge, and the documented-but-never-written `limit_reached` status are all gone. It never fired under any realistic config: the hook built a FRESH `BudgetTracker` per PostToolUse and fed it a SINGLE payload, so nothing accumulated across a session — `shouldBlockSpawning` needed one **> 6.8 MB** tool payload to trip at the 2 M default (structurally unreachable, reproduced), and `limit_reached` had no writer at all. Same structural flaw as the beta.6 `maxTurns`/`warningTurnThreshold` tombstone; the token half now matches. A gauge that only sees the hook's payload char-slice cannot be a budget safety device (per-turn token use is unknowable from it), and a config knob that does nothing is a false promise. **The recovery core (journal + warm-resume) is untouched.** A `.coalhearth.json` still carrying a `budgets` block is now ignored at runtime and flagged as an unknown group by `configure`/`verify`.

### Fixed
- **Concurrency — N concurrent PostToolUse hooks no longer lose each other's journal.** The load→merge→save is serialized under a per-workspace `O_EXCL` lock (`lib/handoff-journal.js` `updateUnderLock`: stale-break + bounded wait → best-effort lock-free fallback; a non-spinning `Atomics.wait` keeps the ≤100 ms Phoenix budget). Lossless to 30 simultaneous writers (a 30-way race dropped all 30 before).
- **A transient-corrupt journal is quarantined, not overwritten.** `recordStep` moves an unparseable `session_handoff.json` to `session_handoff.corrupt.json` (bytes preserved) before starting fresh — it used to silently overwrite it, losing the bytes and the accumulated state.
- **A second session in the same workspace no longer discards the first's journal.** The journal now carries the hook payload's `session_id`, and `recordStep` keys "same session" on it — so a second session booting (which flips the shared journal to `resumed`) no longer makes the first session's next step rebuild from empty. Also completes CoalWash's estate `sessionId` guard.
- **A wrong-typed journal field no longer eats the recovery block.** `generateHandoffPrompt` array-coerces every field before mapping, and mark-resumed moved to AFTER a successful prompt build — a corrupt/foreign shape can no longer throw (fail-silent) and leave the journal `resumed` with no block shown (permanently unrecoverable).
- **A file blocking `.claude/coalhearth` now signals** on SessionStart's sanctioned channel instead of leaving warm-resume silently off while the user believes they're protected.

### Changed
- **All journal writes are atomic (per-pid temp + rename)** — `save()`, mark-resumed, and the corrupt-quarantine share one atomic writer, so a crash mid-write can't leave a torn journal.

## [1.4.0] - 2026-07-16

**MINOR** — CoalHearth ports to the config-only hook platforms: **Gemini CLI, GitHub Copilot CLI, Devin CLI, Kiro, and Augment Code** — five wiring templates over the SAME two adapter entry points (no new hook files). Every one ships a native session-start-class event, so none needs Antigravity's once-per-session marker workaround. Tier for all five: **wired** — built + hermetically tested against each platform's primary docs (2026-07-15 fetch), NOT validated: no live session on any of them has run the wiring yet; a real run per platform flips it.

### Added
- **Platform-mode dispatch** in the two non-Claude-Code entry points (the CoalMine v3.11 argv pattern: named modes exact-matched BEFORE the generic-truthy Antigravity branch). [`bin/ag-pre-invocation.js`](bin/ag-pre-invocation.js) gains `SessionStart` (Gemini CLI: genuine per-session event — no marker, no session-key requirement; emits Gemini's NESTED `{"hookSpecificOutput":{"additionalContext"}}`, the only inject shape its SessionStart accepts — the flat AG shape is silently dropped there) and `FileCopy` (Copilot CLI / Devin CLI / Kiro / Augment: native session-start events — no marker; emits the plain Claude-Code stdout block their CC-shaped protocols model). [`bin/ag-post-tool-use.js`](bin/ag-post-tool-use.js) gains `AfterTool` (Gemini) and `FileCopy`. No argv — or the shipped `PreInvocation`/`PostToolUse` — keeps the Antigravity behavior unchanged (the pre-existing AG test suite passes untouched as the regression proof).
- **[`platform-configs/hooks/`](platform-configs/hooks/)** — the five wiring templates + a README (wiring table, verified-vs-best-guess notes per platform): `gemini-settings-hooks.json` (merge into `.gemini/settings.json`; audience caveat: Gemini CLI individual tiers were cut off 2026-06-18 — business Standard/Enterprise only) · `copilot-cli-hooks.json` (`.github/hooks/coalhearth.json` repo or `~/.copilot/hooks/coalhearth.json` user; camelCase events, bash+powershell command pairs) · `devin-cli-hooks.json` (`.devin/hooks.v1.json`; PascalCase, an explicit CC-schema clone) · `kiro-agent-hooks.json` (merge snippet into `.kiro/agents/<name>.json`; `agentSpawn` is the session-start-class event) · `augment-settings-hooks.json` (merge snippet into `.augment/settings.json`; its SessionStart stdout inject is the one doc-verified file-copy channel). The Antigravity template deliberately stays at its existing `platform-configs/hooks.json` path — the installed tooling reads it in place; a move would break it (named divergence).
- **Journal normalizer** learns Gemini CLI's two file tools (`write_file`, `replace`) and the camelCase `toolInput`/`toolResponse` payload probe (the Copilot-CLI shape) — degrade-safe as before: an unmapped tool is a no-op contribution, never a wrong write.
- **7 hermetic platform-mode tests** ([`bin/ag-hooks.test.js`](bin/ag-hooks.test.js), spawning the real hook files sandboxed: nested-emit shape, keyless named-mode resume, plain-stdout parity, Gemini nudge suppression, camelCase probe) → 124 total.
- **Not wired, by design:** **Junie** (`SessionStart` is its ONLY hook event — no per-tool event means no journal, so resume would have nothing to read) and **Devin Desktop "Cascade Hooks"** (its snake_case vocabulary — `pre/post_write_code`, `post_cascade_response` — carries no session-start-class event, so there is no resume anchor; a separate surface one adapter can never share with Devin CLI). One line each in the README compat matrix.

### Changed
- **Named divergence — the advisory budget nudge is SUPPRESSED on Gemini:** the only Gemini inject channel verified against the primary docs is SessionStart's nested `hookSpecificOutput` field; `AfterTool` documents none, and the nudge is secondary-advisory — Phoenix #13 zero-noise beats a best-guess emit Gemini's parser might surface as garbage. The journal itself (the core value) records every step there regardless.
- README: compat matrix (validated / wired / not-supported per platform, with the event pair and wiring file per row) replaces the old two-platform install story; SECURITY.md's hook-surface note now names the per-platform emit shapes.

## [1.3.2] - 2026-07-15

**PATCH** — security hardening follow-up to v1.3.1.

### Security
- **Marker subdir hardened against a pre-planted symlink** (`bin/ag-pre-invocation.js`): an `lstatSync` no-follow check rejects a symlink at the marker subdir (which `mkdirSync(recursive)` would otherwise follow, bypassing the `0o700` mode), then routes to the existing recovery path — the resume block still emits with the honest "may repeat" note (named divergence kept). One-flock with CoalMine v3.11.1 / CoalFace v0.3.2. Completes the CodeQL `js/insecure-temporary-file` mitigation. Tests 20/20.

## [1.3.1] - 2026-07-15

**PATCH** — closes a CodeQL HIGH (`js/insecure-temporary-file`) on the Antigravity resume shim's once-per-session marker; a hermetic-test sandbox leak fix rides along.

### Security
- **AG once-per-session marker hardened against a TOCTOU race** (`bin/ag-pre-invocation.js`): replaced the old check-then-write (`existsSync` then `writeFileSync`) with an atomic create-exclusive latch — `fs.writeFileSync(marker, '', { flag: 'wx' })` inside a private `0o700` `os.tmpdir()/coalhearth/` subdir. The `wx` flag makes the create itself fail `EEXIST` if the marker path already exists in ANY form (a prior turn's marker, or a planted file/symlink), closing CodeQL `js/insecure-temporary-file` (HIGH) and refusing a symlink target in the same syscall. Named divergence kept: a non-`EEXIST` create failure (e.g. a read-only temp dir) still emits the recovery block, now carrying an honest "may repeat" note — a recovery payload is worth repeating, unlike an advisory directive.

### Fixed
- **Hermetic-test sandbox leak**: two sandbox directories leaked per run in `bin/ag-hooks.test.js` — the inline `mk()` results are now bound to a variable and cleaned up in a `finally` block (`bin/ag-hooks.test.js`, 19/19).

## [1.3.0] - 2026-07-14

**MINOR** — CoalHearth runs on Antigravity. AG 2.0 shipped a real hook engine (`hooks.json`; empirical pilot 2026-07-12, corroborated against the official docs 2026-07-13), retiring the "Claude Code only — no other agent platform runs hooks" premise. The port is built + hermetically tested against that verified spec; live AG validation is still pending (tier: **wired**, not validated — delivery of the injected context into the agent is emitted per spec, unproven end-to-end; one real AG session run flips it).

### Added
- **Antigravity adapters.** [`bin/ag-pre-invocation.js`](bin/ag-pre-invocation.js) — warm-resume rides the FIRST `PreInvocation` of a session (AG never fires `SessionStart`); a per-session tmp marker keeps it once-per-session (PreInvocation fires per MODEL call), written BEFORE the emit per the v1.2.1 write-ordering lesson, with an honest "may repeat" note on write-fail. [`bin/ag-post-tool-use.js`](bin/ag-post-tool-use.js) — the journal step per tool call, with a defensive payload normalize (AG core fields are snake_case, camelCase accepted; an unmapped tool name is a no-op, never a wrong write). Emit = one `{"additionalContext"}` JSON line, AG's sanctioned injection channel.
- **`platform-configs/hooks.json`** — the AG wiring template (named-group wrapper, external-script commands; copy to `<workspace>/.agents/hooks.json` or `~/.gemini/config/hooks.json`, replace `__COALHEARTH_DIR__`).
- **`lib/journal-step.js`** — the journal core both platforms share; `bin/post-tool-use.js` (Claude Code) is now a thin adapter over it, behavior identical.
- **16 hermetic AG-hook tests** (`bin/ag-hooks.test.js`, spawning the real hook files sandboxed) → 113 total.
- Deliberately NOT ported: the self-update nudge — its payload (`claude plugin update coalhearth@coalhearth`) is Claude-Code-plugin-specific; AG installs by file-copy, so that instruction would be wrong there.

### Fixed
- **Cross-session journal contamination on the new AG path** (rot-canary HIGH, 2026-07-13 — caught and fixed pre-release): `lib/journal-step.js` treats a prior `in_progress` journal as the CURRENT session's accumulator, so a dead session left unmarked would leak its `modifiedFiles`/`inFlightAgents` into the next session's first save, growing unbounded across crash chains. The AG resume shim now marks the journal `resumed` BEFORE emitting (the Claude Code path already did), restoring the status-proxy invariant; regression test included. Tradeoff accepted, same as Claude Code's: a session that dies before its first tool call won't re-offer that recovery.

## [1.2.1] - 2026-07-09

**PATCH** — two LOW fixes from the CoalBoard nasa full-mirror audit (2026-07-09, finding L6). No new capability.

### Fixed
- **CHANGELOG double-MINOR**: the v1.2.0 release commit renamed the existing `## [1.1.0]` heading in place instead of inserting a new heading above it, so this file stacked two unrelated MINOR change-sets (the 1.1.0 `/coalhearth:stats` + self-update conform, and the 1.2.0 Workflow-tracking work) under one `## [1.2.0]` heading with two `**MINOR**` labels. Both versions were already tagged correctly (`v1.1.0` @ 2026-07-08, `v1.2.0` @ 2026-07-09) — only this file's bookkeeping was wrong. Split back into their own headings below; no version was renumbered, no tag touched.
- **Read-only-fs resume re-inject** (`bin/session-start.js`): the mark-resumed write ran *after* the recovery block was already printed, and any failure (e.g. a read-only journal directory) was swallowed silently — so a filesystem that can never persist "resumed" re-injected the identical recovery block on every subsequent boot, forever, with no indication why. The mark-resumed write now runs first; on failure the recovery block itself gains a one-line honest note ("could not mark this session resumed … this recovery block may repeat next session"). Still Phoenix-13 fail-silent (exit 0, no new writes, no retry outside the sandbox root) — a genuinely read-only fs cannot be fixed by more code, so the fix is honesty, not persistence. Hermetic regression test: a read-only journal file still exits 0 and now says "may repeat".

## [1.2.0] - 2026-07-09

**MINOR** — the in-flight tracker learns the third spawn shape. Field-driven: a 52-agent `Workflow` run hit a session limit (8 workers dead) and the outer session had ZERO record the run existed — `Workflow` was not in the spawn-tool set, so the recovery block could not point the next session at the run's own `journal.jsonl`.

### Added
- **`Workflow` runs are journaled into `inFlightAgents`** (`bin/post-tool-use.js`): the spawn-tool set gains `Workflow`; the record uses the workflow's `name`/`scriptPath` as its description, tags `subagentType: 'workflow'`, and probes `transcriptDir`/`scriptPath` as the residue path (the run's own `journal.jsonl` lives there — CoalHearth records that the run EXISTED and where its journal is; the per-agent truth stays in that journal, honest-scope unchanged). Hermetic test extended (a Workflow spawn accumulates with name/tag/residue asserted).

## [1.1.0] - 2026-07-08

**MINOR** — the measurement standard-system lands.

### Added
- **`/coalhearth:stats`** (`commands/stats.md`) — the standardized measurement command (series standard-system #5): the current session's journal state (last update, modified files, in-flight subagents), resume events (did this session warm-resume, and did the snapshot match reality), and the advisory budget estimate when surfaced (labeled approximate). Read-only; honest empty state.

### Changed
- **Self-update wording aligned to the series gold phrasing** (one-flock conform): the SessionStart nudge and `commands/update.md` now say *web-check the latest tag vs the installed `plugin.json` version … if git/network is unavailable, say so and suggest updating manually later (never assume)* — the `git ls-remote` hard-coupling is gone (git remains a usable means, not an assumed one).
- Relicensed from MIT to Apache-2.0. `LICENSE` is now the Apache License 2.0 (verbatim); a new `NOTICE` carries the attribution; the `plugin.json` `license` field is `Apache-2.0`. No code or behavior change.

## [1.0.0] - 2026-07-02

**First stable release.** CoalHearth graduates from beta. The recovery core (atomic per-step journal + warm-resume recovery block, two Phoenix-13 hooks) proved itself on a **live interrupted session** this cycle — not just the hermetic fake-cases — and the beta→1.0 graduation gate, **Incident E sub-flight tracking** (beta.10), closed the one honest gap the fan-out case exposed. Same code as `0.1.0-beta.10`; this promotes it to stable. Platform: Claude Code only (it *is* two hooks; no other agent platform runs them — stated in the install docs). The full hardening trail — macOS-CI symlink iteration, journal-dir containment, spawn-free snapshot (Phoenix #5), the `\Z`-anchor and realpath fixes — is in the beta entries below.

## [0.1.0-beta.10] — 2026-07-02

**The beta→1.0 graduation-gate item — sub-flight tracking (Incident E) — plus two board LOW fixes.**

### Added
- **Sub-flight tracking: the PostToolUse hook now journals every fanned-out subagent spawn (Incident E, MEMORY.md Field Evidence).** When a board/swarm's workers die on a session limit or user-stop, their in-flight work is lost AND main had no record of what was running — proven live twice (Incidents A + E). The hook already parses each tool-call payload; on an `Agent` (or legacy `Task`) spawn it now records `{description, subagentType?, outputPath?, spawnedAt}` into a new `inFlightAgents` journal array, accumulated across hook runs like `modifiedFiles`. The recovery block gains an **"In-flight subagents at interruption (verify/re-spawn as needed)"** section listing each, so a resumed session knows which subs were running and where their residue lives — turning what main did BY HAND this session into data. **Honest scope (stated in code + PRIVACY):** this does NOT recover a dead sub's *work* (that would need the sub itself to journal, which the parent can't force) — it RECORDS that the sub existed + where residue may live, so main/human can reconstruct or re-spawn. `description`/`subagent_type` come from the documented Agent-tool arg schema; the residue path is a best-effort probe of `tool_response` (its exact shape is undocumented/version-dependent, so a missing path is normal).

### Fixed
- **LOW — `lib/contained-dir.js` created the output dir BEFORE the physical containment check**, so a lexically-inside path that symlink-escapes root leaked an incidental empty dir OUTSIDE root before the function correctly returned null (fail-closed on the return, but the outside dir already existed). The physical check now runs BEFORE `mkdirSync`: the candidate's nearest existing ancestor is realpath-resolved (following any symlink in the existing prefix) and re-joined with the not-yet-created tail, contained under the realpath'd root; only a contained candidate is created. A `root/.claude`-junctioned-to-victim + `outputDirectory:".claude/coalhearth"` now creates nothing outside root. Happy path (a legit in-workspace dir) intact.
- **LOW — `PRIVACY.md` doc-stale**: the journal's modified-file names were described as read "from `task.md` / `git status`", but beta.6 made the hook spawn-free (no `git`). Now matches README/SECURITY: the names come from the `Write`/`Edit`/etc. tool-call payloads the hook observes.

## [0.1.0-beta.9] — 2026-07-02

### Fixed
- **Completes the beta.8 macOS test-sandbox fix — a third hermetic sandbox needed the same realpath.** beta.8 realpath-resolved the `hooks.test.mjs` and `state-snapshot.test.js` tmpdir sandboxes, but the `bin/post-tool-use.test.js` `mk()` helper (`coalhearth-ptu-`) was still raw, so its "modifiedFiles accumulates from Write/Edit payloads across hook runs" case stored the file absolute (`/var/folders/.../src/a.js`) instead of relative (`src/a.js`) on `macos-latest` — the one remaining CI failure. Now realpath'd like the other two; no-op off macOS.

## [0.1.0-beta.8] — 2026-07-02

### Fixed
- **The macOS `modifiedFiles` CI failure is a test-sandbox artifact, not a production bug — corrects beta.7's approach.** beta.7 added a hot-path `realpath` to `mergeModifiedFiles`, which was itself CI-red: `realpath` needs the target on disk, but a not-yet-written file left the root resolved (`/private/var`) and the file lexical (`/var`) — a NEW asymmetry that broke two unit tests too (fail 2 → 3 on macOS). Root cause: `os.tmpdir()` on macOS is `/var` symlinked to `/private/var`, so a spawned hook's `process.cwd()` resolves to `/private/var` while the test's payload path stays `/var` — a hermetic-isolation quirk, not something a real (non-symlinked) workspace hits. Reverted the hot-path realpath (production code is lexical again; a symlinked-workspace user at worst gets an absolute path in the advisory journal — cosmetic) and instead **realpath the tmpdir sandboxes in the hermetic tests** (`hooks.test.mjs` `sandbox()`, `state-snapshot.test.js` `tmpDir()`) so the paths asserted against match the physical form the hook sees. Same "realpath the sandbox in tests" lesson as the beta.5 stop-at-home CI catch.

## [0.1.0-beta.7] — 2026-07-02

### Fixed
- **`mergeModifiedFiles` (state-snapshot) attempted to realpath-resolve BOTH the workspace root and the touched file before relativizing** (superseded by beta.8 — this hot-path realpath was CI-red on the file-not-yet-on-disk asymmetry; the fix belongs in the test sandbox, not production). On macOS `process.cwd()` returns the physical `/private/var/...` path while a tool payload's `file_path` is often the raw `/var/...` symlink, so the lexical `path.relative` spuriously started with `..` and stored the file as an absolute path instead of the clean relative one — beta.6's payload-derived `modifiedFiles` test failed on `macos-latest` (both Node lanes) for exactly this. realpath falls back through the file's existing parent dir (a half-applied edit may not be on disk yet), then the lexical path; never throws (Phoenix #4). Same realpath-both-sides class as the beta.5 stop-at-home fix — caught by the first CI run on macOS.

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
