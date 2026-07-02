<div align="center">

# 🔥 CoalHearth

> *A hearth keeps the home warm and banks the embers so the next day's fire lights fast.* This one banks a Claude Code session's state so an interrupted session resumes from a handoff instead of a manual rebuild.

**A session warm-resume + budget-guardrail engine.** A hook journals your session's state every step; if the next session finds the prior one was interrupted, it injects a markdown recovery block so you continue where you left off. A secondary, advisory budget nudge warns before a fan-out spawn when headroom looks low.

![version](https://img.shields.io/github/v/tag/TheColliery/CoalHearth?label=version&color=blue)
![license](https://img.shields.io/badge/license-MIT-blue)
![status](https://img.shields.io/badge/status-beta-orange)

[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Releases](https://github.com/TheColliery/CoalHearth/releases)

**Part of [TheColliery](https://github.com/TheColliery)** — siblings: **[CoalMine](https://github.com/HetCreep/CoalMine)** (quality canaries) · **[CoalTipple](https://github.com/TheColliery/CoalTipple)** (model/effort routing) · **[CoalBoard](https://github.com/TheColliery/CoalBoard)** (consensus board).

</div>

---

## 🔥 What it is

A session limit-hit or a crash loses in-flight work — the plan, the checklist, the list of files you were mid-edit on. CoalHearth **reduces that loss**:

- **The recovery core.** A `PostToolUse` hook builds a best-effort snapshot of the session (goal + checklist from `task.md`, constraints from `AGENTS.md`, modified files accumulated from the file-editing tool calls the hook observes — no `git` spawn, no child processes) and journals it **atomically** every step to `session_handoff.json`.
- **Warm-resume on boot.** On the next session's `SessionStart`, if the prior session's journal is still marked `in_progress` or `limit_reached`, CoalHearth injects a markdown **recovery block** — the goal, the checklist, the files it was touching, the planned next steps — so you resume from context instead of reconstructing it by hand.
- **The recovery block never asks you to blind-trust it.** It always tells the agent to **verify against `git status` / `git diff`** first — the journal may be stale or half-applied.

That recovery core is the value. Everything else is secondary.

## 📉 Budget guardrail (secondary, advisory)

Alongside the journal, the same hook keeps a char-heuristic token estimate. When the estimated token headroom drops below the configured percentage, it emits **one advisory line** suggesting the agent prefer inline work over spawning subagents — because a fanned-out worker that dies on the limit returns nothing.

This is a **best-effort nudge, not a hard block.** The model decides whether to actually collapse to inline; nothing is enforced.

## 🛡️ What it does (and does NOT) guarantee

CoalHearth **reduces the damage** of a session limit-hit — it does **not** prevent one, and it guarantees nothing:

- The budget guardrail is a **char-heuristic estimate** (≈4 chars/token ASCII, ≈1.5 non-ASCII), **not** a precise or authoritative read of the platform's real limit. Treat it as advisory only; real budget enforcement is the platform's.
- The recovery journal is a **best-effort snapshot**, not a guarantee it's still accurate — code may have moved since the last save, which is exactly why the recovery block tells the agent to verify against git.
- Work done by **fanned-out workers** that die on a limit is **unrecoverable** — they journal nothing. The journal snapshots the *main* session; the guardrail's job is to nudge you away from the fan-out edge before that happens.

Honest sell: **less lost work on an interruption, plus an early low-headroom nudge** — not a limit-proof session.

## 🚀 Install

**Claude Code** — one command (this also wires the two hooks: `SessionStart` = resume, `PostToolUse` = journal):

```bash
claude plugin marketplace add TheColliery/CoalHearth
claude plugin install coalhearth@coalhearth
```

That's it — the hooks activate on your next session. No API keys, no network, no configuration required to start.

## ⚙️ Configure

Everything is tunable in `.coalhearth.json` (global `~/.claude/` overlaid per-group by a project `.coalhearth.json`; the project lookup walks up from the cwd and **stops at your home dir**). A fully-commented factory template ships as [`platform-configs/.coalhearth.json`](platform-configs/.coalhearth.json); the schema is [`config/schema.json`](config/schema.json). Every key is optional and falls back to the default below.

| Group | Key | Default | What it does |
|---|---|---|---|
| `budgets` | `maxTokens` | `2000000` | Token ceiling for the char-heuristic estimate. |
| | `warningTokenPercentage` | `0.15` | Nudge when estimated token headroom drops to this fraction or less. |
| `journal` | `outputDirectory` | `.claude/coalhearth` | Where `session_handoff.json` is written. Realpath-contained under the workspace root — a path escaping it (e.g. from an untrusted repo's config) falls back to the default. |
| | `atomicityRetries` | `3` | Atomic write-then-rename retries before giving up (fail-silent; clamped 1-5 — the retry backoff is a synchronous wait on the hot-path). |
| `recovery` | `autoInjectPrompt` | `true` | Inject the recovery block on resume. `false` = detect + sweep silently, no injection. |
| | `stashUnsavedChanges` | `true` | Add a "consider `git stash`" advisory line to the recovery block. `false` drops it. The hook never stashes for you. |
| `update` | `updateMode` | `ask` | Self-update handling: `ask` · `auto` · `remind` · `off`. The hook only schedules; the agent verifies + offers, consent-gated. |
| | `updateCheckDays` | `14` | Days between self-update checks (1-365; out-of-range clamps to the default on read). |

> The `budgets` numbers are **advisory thresholds for a best-effort heuristic**, not a precise limit read — see the honest frame above.

Check for updates any time with **`/coalhearth:update`** — the agent compares the latest release tag to the installed version and offers `claude plugin update coalhearth@coalhearth`. The hook never networks; the check is the agent's, run with your consent.

## 🪝 The two hooks

Both are Phoenix-13 hooks — **fail-silent** (any error is swallowed, exit 0, never crashes the host), **zero-dependency** (Node builtins only), **no network**, **no child processes**, and they emit only their one sanctioned channel.

- **`SessionStart` → resume** ([`bin/session-start.js`](bin/session-start.js)): reads the journal, and if the prior session was interrupted, prints the recovery block on the sanctioned SessionStart context-injection channel, then marks the journal `resumed` so it isn't re-injected every boot. When a periodic self-update check is due (see `update.*`), it also prints a one-line `/coalhearth:update` nudge on the same channel — the hook only schedules via a local throttle stamp; the online check is the agent's, consent-gated. A headless/cron start is safe by construction — the hook only prints, it never asks anything.
- **`PostToolUse` → journal** ([`bin/post-tool-use.js`](bin/post-tool-use.js)): builds the state snapshot and saves it atomically, then runs the advisory budget check and prints the one nudge line only when headroom is low.

## 🧭 Part of TheColliery

CoalHearth is the **session-continuity** member of the mining series, alongside [CoalMine](https://github.com/HetCreep/CoalMine) (quality canaries), [CoalTipple](https://github.com/TheColliery/CoalTipple) (model/effort routing), and [CoalBoard](https://github.com/TheColliery/CoalBoard) (consensus & debate). Install one and it stands alone; install all and they compose without conflict. Shared doctrine: Phoenix-13 hooks (zero-dependency, no network, fail-silent, no child processes, deterministic), single-source-of-truth config schemas, and a strict no-overkill discipline. Series doctrine: [`TheColliery/.github`](https://github.com/TheColliery).

Zero-dependency, offline, no API keys.

---

## 📄 License

MIT License. See [LICENSE](LICENSE).
