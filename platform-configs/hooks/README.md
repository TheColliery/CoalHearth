# CoalHearth hook wiring per platform (config-only ports)

Only Claude Code (plugin route) wires automatically. Every snippet below is **manual**: copy it into place, adjust the CoalHearth clone path, and test in your setup. Both hooks run through the same two entry points on every platform — `bin/ag-pre-invocation.js` (warm-resume) and `bin/ag-post-tool-use.js` (journal) over the shared `lib/journal-step.js` core — discriminated by the trailing argv the snippet passes (`SessionStart` = Gemini's nested emit · `FileCopy` = the plain Claude-Code shape · anything else = Antigravity).

**Tier honesty:** every platform below is **wired** — built + hermetically tested against the platform's primary docs (fetched 2026-07-15) — NOT validated: no live session on that platform has run the wiring on this side yet. A row never claims "works on X" until one has. Where a response/inject schema is unverified, the shipped shape is a named best-guess in that config's `$comment`.

| File | Platform | Events used | Docs |
|---|---|---|---|
| [`../hooks.json`](../hooks.json) | Antigravity 2.0 (`<workspace>/.agents/hooks.json` or `~/.gemini/config/hooks.json`) — stays at its own `platform-configs/hooks.json` path (read in place by the installed tooling; a move would break it — named divergence from this dir) | `PreInvocation` (resume, once-per-session tmp marker — AG never fires SessionStart) / `PostToolUse` (journal); flat `additionalContext` emit | antigravity.google/docs/hooks |
| `gemini-settings-hooks.json` | Gemini CLI — merge into `.gemini/settings.json`; **business-tier product** (individual/AI-Pro/Ultra tiers cut off 2026-06-18 — business Standard/Enterprise only) | `SessionStart` (genuine per-session — no marker; NESTED `hookSpecificOutput.additionalContext` emit, the only inject shape its SessionStart accepts) / `AfterTool` (journal; the advisory nudge is suppressed — no verified inject channel there) | github.com/google-gemini/gemini-cli docs/hooks + geminicli.com/docs/hooks |
| `copilot-cli-hooks.json` | GitHub Copilot CLI (`.github/hooks/coalhearth.json` repo or `~/.copilot/hooks/coalhearth.json` user) — NOT the VS Code/cloud PascalCase surface | `sessionStart` / `postToolUse` (camelCase), plain Claude-Code shape — sessionStart's exact inject field unverified | GitHub Copilot CLI's official hook docs |
| `devin-cli-hooks.json` | Devin CLI ONLY (`.devin/hooks.v1.json`) — NOT Devin Desktop/Cascade (see below) | `SessionStart` / `PostToolUse` (PascalCase, an explicit CC-schema clone), plain Claude-Code shape — response schema unverified end-to-end | Devin CLI's official hook docs (docs.devin.ai cli/extensibility) |
| `kiro-agent-hooks.json` | Kiro — MERGE SNIPPET into `.kiro/agents/<name>.json`'s own `"hooks"` key (not a standalone file) | `agentSpawn` (the session-start-class event) / `postToolUse` — response/inject schema entirely unverified, plain Claude-Code shape as a best-guess | kiro.dev/docs/cli/hooks |
| `augment-settings-hooks.json` | Augment Code — MERGE SNIPPET into `~/.augment/settings.json` (user) or `<workspace>/.augment/settings.json` (project) | `SessionStart` (verified stdout inject — the one doc-verified file-copy channel) / `PostToolUse` | docs.augmentcode.com/cli/hooks |

Not wired, by design:

- **Junie** — `SessionStart` is its ONLY hook event. No per-tool event means no journal, and warm-resume would have nothing to read; CoalHearth is the journal+resume pair or nothing, so Junie is out entirely.
- **Devin Desktop "Cascade Hooks"** — a second, separate Devin surface (`hooks.json` at Windsurf-branded OS paths) on its own snake_case vocabulary (`pre/post_write_code`, `post_cascade_response`, …) that carries **no session-start-class event** — no resume anchor, so no config is shipped. One adapter never serves both Devin surfaces.
- **OpenCode / Cline CLI** — plugin-CODE hook surfaces (a JS/TS module, not a static config file): out of scope for this snippet set, a separate future lane.

Notes:

- The self-update nudge is deliberately absent on every platform here — its payload (`claude plugin update coalhearth@coalhearth`) is Claude-Code-plugin-specific; these platforms install by file-copy, so update by re-copying the clone.
- No platform above needs Antigravity's once-per-session tmp marker: each has a genuine session-start-class event. The marker (and its hardened atomic-create pattern) remains AG-only.
