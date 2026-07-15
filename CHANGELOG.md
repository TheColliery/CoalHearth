# Changelog

All notable changes to CoalHearth are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer (the canonical version lives in `.claude-plugin/plugin.json`).

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

## [1.0.0] — 2026-07-02

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
