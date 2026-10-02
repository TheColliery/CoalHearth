# Security Policy

CoalHearth is a zero-dependency, hook-pair-keyed plugin — validated on Claude Code, works with 6 other platforms (Antigravity, Gemini CLI, Copilot CLI, Devin CLI, Kiro, Augment). Its security posture:

## Reporting
Report a security issue in this repo through GitHub's private vulnerability reporting — [Security → Report a vulnerability](https://github.com/TheColliery/CoalHearth/security/advisories/new) — never a public issue. In scope: the shipped hooks (`bin/session-start.js`, `bin/post-tool-use.js`, `bin/user-prompt-submit.js`, and the Antigravity/config-only adapters), the `lib/` journal + resume core, the installer and other `scripts/`, and the `plugin/` dist built from them. Out of scope: a vulnerability in a project's own rules/config file that CoalHearth merely reads as untrusted data (a hostile `AGENTS.md` or `.coalhearth.json`) — that is the project's own security question, not this tool's. This is a one-person-maintained project: expect the report to be read and acknowledged, triaged against the scope above, and disclosed once a fix ships, with no fixed response-time SLA. A public GitHub issue remains the right channel for an ordinary, non-security bug.

## Commit & tag signatures

Every release tag and maintainer commit is SSH-signed (`gpg.format=ssh`); GitHub shows the Verified badge on them. Automated Dependabot / CI commits are not signed with the maintainer key (GitHub signs these with its own), so verify a signed release tag — the artifact a release consumer trusts:

```bash
echo "* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtqTWGKhX1Dk9nZP8ns13Wl5zsO1Cz3VlTS6m1p2fP9" > coalhearth_signers
git config gpg.ssh.allowedSignersFile ./coalhearth_signers
git tag -v "$(git describe --tags --abbrev=0)"
```

## Dist Integrity
- **`plugin/` is generated, never hand-edited** — it's the Claude Code distribution the marketplace serves.
- **`scripts/verify.mjs` compares dist against source in both directions** — byte-exact, with a CRLF/LF-normalized fallback on text files only (so a checkout's line-ending doesn't false-flag byte-identical content) — a stale dist and a dist-only orphan both fail the gate.
- **`scripts/build-plugin.mjs` reproduces `plugin/` from source; `scripts/test.mjs` runs the zero-dependency suite** — a cloner reproduces the exact shipped bytes with `node scripts/build-plugin.mjs && node scripts/verify.mjs`.

<!-- version-transition: SkillSpector scan — the re-scan is automatic on one event (E2: this repo's own version bump, gated by a per-repo baseline diff); a genuinely new attack surface is a second, by hand. (E1, a weekly new-SkillSpector-version watcher, was retired on the owner's word on 2026-09-26.) Record the version/score/date/commit here only after a real scan. Last run: SkillSpector v2.12.0 · CoalHearth v2.6.0 (commit bdde0af) · 2026-09-24 · 100/100 · 12 false positives, static coverage partial (10/16 files). Line refs drift on skill edits — verify against the fresh scan output. (This file is at the repo root, OUTSIDE the scanned plugin/ dir, so this comment is not scanned.) -->
## 🔬 Independent Scanning — NVIDIA SkillSpector

Last scan: CoalHearth **v2.6.0** dist (`plugin/`, commit `bdde0af`, the `v2.6.0` tag; `plugin/` identical at branch HEAD `8ca0798`), on **2026-09-24**, with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) **v2.12.0** (self-reported version string; scan pinned to commit `c7958a3`, upstream's tag `v2.12.0`), static stage (`--no-llm`). **Score 100/100 (CRITICAL), 12 findings, all false positives on adjudication.** The CRITICAL rating rests on a single `TM1` match of the string `git clean -fdX` — which appears only inside a source comment recording a path-containment bug that was **found and fixed** on that file; the plugin contains no command-execution primitive of any kind, so no such command can run from it. The rest: RA1 ×7 on the word "self-update" (comments, the `/coalhearth:update` OFFER directive, and a note that the nudge is deliberately NOT ported to the Antigravity path), EA2 ×2 matching "no consent" inside a sentence stating that no consent-persistence call exists, RA2 ×1 on the same fixed-bug comment, and BH1 ×1, the scanner's notice that `hooks/hooks.json` registers lifecycle hooks. Static coverage was **partial** (10 of 16 files fully inspected): five JavaScript files (`bin/ag-pre-invocation.js`, `bin/user-prompt-submit.js`, `lib/handoff-journal.js`, `lib/journal-step.js`, `lib/resume-engine.js`) reached the scanner's parser span limit and `hooks/hooks.json` is opaque to it. Those six were read by hand at v2.5.0 (including the journal's contained-sweep logic); the v2.5.0 to v2.6.0 change (a config-reader notice refactor, a bounded-poll fix on lock contention, one recovery-text edit) was read in full. The score is not comparable to the 53 recorded at v2.3.9: the previous dist (v1.0.0) re-scanned with v2.11.2 scores 68, and the v2.5.0 dist re-scanned with v2.12.0 also scores 100 with the same 12 findings.

* **Method:** `uvx --from git+https://github.com/NVIDIA/skillspector.git skillspector scan <plugin> --format json` — uvx fetches its own ephemeral Python, so no manual Python/pip install is needed; a JSON report is written even when the optional LLM stage is skipped.
* **LLM Semantic Scan:** not run this pass (`--no-llm` — static-only is the documented, FP-prone baseline: pattern-match without the skill-contract context).

## Attack surface
- **Zero dependencies** — no third-party packages, so no dependency-CVE surface (nothing to `npm audit`; the lockfile-scan step other projects need is N/A here).
- **No network** — the engine is entirely local filesystem; it never makes a network request.
- **Node builtins only** — `fs`, `path`, `os`. **No child processes** — the hooks spawn nothing (the earlier best-effort `git status` spawn was removed; modified files come from the tool-call payloads the hook observes).

## Hook safety (Phoenix-13)
- The `SessionStart`, `PostToolUse`, and `UserPromptSubmit` (Claude Code only, `bin/user-prompt-submit.js`, issue #13) hooks — and their multi-platform adapters (`bin/ag-pre-invocation.js`, `bin/ag-post-tool-use.js`, thin shims over the same shared core, argv-switched per platform: Antigravity / Gemini CLI / Copilot CLI / Devin CLI / Kiro / Augment) — are **fail-silent**: all logic is wrapped in try/catch, they exit 0 on every path, and they never crash the host agent.
- The only output is the sanctioned context injection (the recovery block — plain stdout on Claude Code and the CC-shaped file-copy platforms, one `{"injectSteps":[{"ephemeralMessage":...}]}` JSON line on Antigravity, one nested `{"hookSpecificOutput":{"additionalContext"}}` line on Gemini CLI); nothing else is written to stdout/stderr.

## Filesystem safety
- **Path-contained orphan sweep.** The resume-time cleanup removes only known scratch/worktree name-patterns, only inside **CoalHearth-owned** dirs (`.claude/coalhearth/scratch`, `.agents/coalhearth/scratch`, and CoalHearth-owned stale worktrees), resolve-and-contained under the workspace root. It NEVER touches the user's own tree (e.g. your `scripts/`) and never does a blind recursive delete.
- **Contained journal directory.** `journal.outputDirectory` (mergeable from an untrusted project `.coalhearth.json`) is realpath-contained under the workspace root at construction — a path escaping the workspace (e.g. `"../../victim"`) clamps to the default owned dir, so neither the journal write, the ENOSPC prune, nor the corrupt-quarantine can be aimed outside.
- **Atomic journal writes** (temp-write + rename, with retry/backoff); a corrupt journal is quarantined aside rather than crashing the boot; a disk-quota error prunes old logs and keeps the core state.

## Config parsing
- The `.coalhearth.json` parse is **prototype-pollution-guarded** — `__proto__` / `constructor` / `prototype` keys are dropped at parse time, so an untrusted project config (e.g. one shipped by a cloned repo) cannot pollute `Object.prototype` through the config merge.

## Honest scope
CoalHearth **reduces** the damage of a session limit-hit; it does not prevent one or guarantee recovery (the recovery block always instructs verification against git — the journal may be stale). External scan provenance is recorded in "Independent scanning" above.
