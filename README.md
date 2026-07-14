<div align="center">

# 🔥 CoalHearth

> *A hearth keeps the home warm and banks the embers so the next day's fire lights fast.* This one banks a Claude Code session's state so an interrupted session resumes from a handoff instead of a manual rebuild.

**A session warm-resume + budget-guardrail engine.** A hook journals your session's state every step; if the next session finds the prior one was interrupted, it injects a markdown recovery block so you continue where you left off. A secondary, advisory budget nudge warns before a fan-out spawn when headroom looks low.

![version](https://img.shields.io/github/v/tag/TheColliery/CoalHearth?label=version&color=blue)
![license](https://img.shields.io/badge/license-Apache_2.0-blue)
![status](https://img.shields.io/badge/status-stable-brightgreen)

![Claude Code: validated](https://img.shields.io/badge/Claude_Code-validated-brightgreen)
![Antigravity: wired](https://img.shields.io/badge/Antigravity-wired-yellow)

[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Releases](https://github.com/TheColliery/CoalHearth/releases)

**Part of [TheColliery](https://github.com/TheColliery)** — siblings: **[CoalMine](https://github.com/HetCreep/CoalMine)** (quality canaries) · **[CoalTipple](https://github.com/TheColliery/CoalTipple)** (model/effort routing) · **[CoalBoard](https://github.com/TheColliery/CoalBoard)** (consensus board) · **[CoalFace](https://github.com/TheColliery/CoalFace)** (fan-out discipline) · **[CoalWash](https://github.com/TheColliery/CoalWash)** (memory defrag) · **[CoalLedger](https://github.com/TheColliery/CoalLedger)** (docs health).

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

CoalHearth *is* two Phoenix-13 hooks (resume + journal), so it installs wherever a platform runs hooks — on Claude Code as `SessionStart` + `PostToolUse`, on Antigravity as `PreInvocation` + `PostToolUse` (adapters over the same shared core).

### Claude Code — validated

One command (this also wires the two hooks):

```bash
claude plugin marketplace add TheColliery/CoalHearth
claude plugin install coalhearth@coalhearth
```

That's it — the hooks activate on your next session. No API keys, no network, no configuration required to start.

### Antigravity — wired (live AG validation pending)

Antigravity 2.0 added a real hook engine (`hooks.json`; empirically confirmed 2026-07-12, corroborated against the official docs 2026-07-13), which **reopens** CoalHearth to AG — the old "Claude Code only, because no other agent runs hooks" premise no longer holds. The port is now **built and hermetically tested** against that verified spec. **wired** = the adapter exists, is tested, and installs as documented; what is *not* yet proven is a live AG session delivering the injected recovery block into the agent — one real AG run flips this to validated. No "works on Antigravity" claim until then.

AG has no plugin manager, so the install is a file copy:

```powershell
git clone https://github.com/TheColliery/CoalHearth.git --depth 1
# global (all workspaces):
Copy-Item -Recurse CoalHearth "$env:USERPROFILE\.gemini\config\skills\coalhearth"
```

Then copy [`platform-configs/hooks.json`](platform-configs/hooks.json) into `<workspace>/.agents/hooks.json` (per project) **or** `~/.gemini/config/hooks.json` (global), and replace `__COALHEARTH_DIR__` with the copied directory. Event mapping (AG never fires `SessionStart`): warm-resume rides the **first `PreInvocation`** of a session — a per-session temp marker keeps it once-per-session, since PreInvocation fires per model call — and the journal rides `PostToolUse`.

Known limits on AG: delivery of the injected `additionalContext` is not yet live-validated (above) · the AG tool-name map is best-effort beyond `write_to_file` (an unmapped tool is simply not journaled — never a wrong write) · the once-per-session temp markers are OS-reaped, not hook-deleted (AG has no end-of-session event) · the self-update nudge is deliberately not ported (its payload is a Claude-Code plugin command; on AG, update by re-copying).

### Other agents — not supported

CoalHearth is hook-only; a platform with no hook layer has nothing to run, and there is no read/analyze mode to load by hand (the way CoalMine or CoalLedger ship one). No file-copy or ZIP-upload install path applies here.

## ⚙️ Configure

Everything is tunable in `.coalhearth.json` (global `~/.claude/` overlaid per-group by a project `.coalhearth.json`; the project lookup walks up from the cwd and **stops at your home dir** — project wins), so you can **re-tune a globally-installed CoalHearth per project** — the closest per-project quiet switch is `recovery.autoInjectPrompt: false` (detect + sweep silently, no recovery block; the journal hook still runs — full off = uninstall). Every key is optional. The high-impact keys:

| Key | Default | What it does |
|---|---|---|
| `recovery.autoInjectPrompt` | `true` | Inject the recovery block on resume. `false` = detect + sweep silently, no injection. |
| `budgets.maxTokens` | `2000000` | Token ceiling for the advisory char-heuristic estimate (see the honest frame above). |
| `budgets.warningTokenPercentage` | `0.15` | Nudge when estimated token headroom drops to this fraction or less. |

Full key reference: every key + default lives in [`scripts/lib/config-schema.mjs`](scripts/lib/config-schema.mjs) and the commented template [`platform-configs/.coalhearth.json`](platform-configs/.coalhearth.json).

## 🪝 The two hooks

Both are Phoenix-13 hooks — **fail-silent** (any error is swallowed, exit 0, never crashes the host), **zero-dependency** (Node builtins only), **no network**, **no child processes**, and they emit only their one sanctioned channel.

- **`SessionStart` → resume** ([`bin/session-start.js`](bin/session-start.js)): reads the journal, and if the prior session was interrupted, prints the recovery block on the sanctioned SessionStart context-injection channel, then marks the journal `resumed` so it isn't re-injected every boot. When a periodic self-update check is due (see `update.*`), it also prints a one-line `/coalhearth:update` nudge on the same channel — the hook only schedules via a local throttle stamp; the online check is the agent's, consent-gated. A headless/cron start is safe by construction — the hook only prints, it never asks anything.
- **`PostToolUse` → journal** ([`bin/post-tool-use.js`](bin/post-tool-use.js)): builds the state snapshot and saves it atomically, then runs the advisory budget check and prints the one nudge line only when headroom is low.

On Antigravity the same two jobs run through thin adapters — [`bin/ag-pre-invocation.js`](bin/ag-pre-invocation.js) (resume, first PreInvocation of a session) and [`bin/ag-post-tool-use.js`](bin/ag-post-tool-use.js) (journal) — over one shared core ([`lib/journal-step.js`](lib/journal-step.js)); the Claude Code journal hook is itself a thin adapter over that core, behavior identical. Same Phoenix-13 discipline on both platforms.

## 📊 Benchmark

Interruption damage, measured (2026-07-03, v1.0.0): on a 10-file mid-refactor, warm resume and cold restart both finished correctly with a **<1% token delta** — at small scale a strong model rebuilds state from the tree, so CoalHearth's token saving is a **large-session** effect. Its irreducible value is state **fidelity**: the in-flight sub-agent record a cold restart cannot reconstruct. Full table + honest scope: [`TheColliery/.github/benchmarks/CoalHearth`](https://github.com/TheColliery/.github/tree/main/benchmarks/CoalHearth).

## 🧭 Part of TheColliery

CoalHearth is the **session-continuity** member of the mining series, alongside [CoalMine](https://github.com/HetCreep/CoalMine) (quality canaries), [CoalTipple](https://github.com/TheColliery/CoalTipple) (model/effort routing), [CoalBoard](https://github.com/TheColliery/CoalBoard) (consensus & debate), [CoalFace](https://github.com/TheColliery/CoalFace) (fan-out discipline), [CoalWash](https://github.com/TheColliery/CoalWash) (memory defrag), and [CoalLedger](https://github.com/TheColliery/CoalLedger) (docs health). Install one and it stands alone; install all and they compose without conflict. Shared doctrine: Phoenix-13 hooks (zero-dependency, no network, fail-silent, no child processes, deterministic), single-source-of-truth config schemas, and a strict no-overkill discipline. Series doctrine: [`TheColliery/.github`](https://github.com/TheColliery).

Zero-dependency, offline, no API keys.

---

## 📄 License

Apache License 2.0. See [LICENSE](LICENSE).
