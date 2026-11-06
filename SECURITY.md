# Verifying CoalHearth

CoalHearth is verified under the same framework as [CoalTipple](https://github.com/TheColliery/CoalTipple/blob/main/SECURITY.md): a zero-dependency, hook-pair-keyed plugin, validated on Claude Code and (plugin path, headless) on Antigravity, works with 5 other platforms (Gemini CLI, Copilot CLI, Devin CLI, Kiro, Augment). Its hooks are Phoenix-13 hooks, its build reproduces from source, and its scans are event-driven.

## 🔒 Reporting a Vulnerability

Report a security issue in this repo through GitHub's private vulnerability reporting — [Security → Report a vulnerability](https://github.com/TheColliery/CoalHearth/security/advisories/new) — never a public issue. In scope: the shipped hooks (`bin/session-start.js`, `bin/post-tool-use.js`, `bin/user-prompt-submit.js`, and the Antigravity/config-only adapters), the `lib/` journal + resume core, `scripts/`, and the `plugin/` dist built from them. Out of scope: a vulnerability in a project's own rules/config file that CoalHearth merely reads as untrusted data (a hostile `AGENTS.md` or `.coalhearth.json`) — that is the project's own security question, not this tool's. The boundary is what CoalHearth does with such a file, not what the file says: a hostile file must not make a hook hang, allocate without bound, or write or delete outside the project, or delete project files it does not own, and one that does is in scope. We acknowledge a report within 5 days, send an assessment within 10 days, and disclose publicly once the fix ships, or at 90 days at most. During an absence announced on the maintainer's GitHub profile, the 5 days count from the first day back. A public GitHub issue remains the right channel for an ordinary, non-security bug.

An advisory is published only for a finding an outsider can exploit through input they control, whatever its level: a repository the user cloned, a file sent to them, a reply from the network. A path only the user feeds (their own config, a command they type) does not count. An unsure finding counts and goes to CoalBoard to decide.

Fixed vulnerabilities are published as [Security Advisories](https://github.com/TheColliery/CoalHearth/security/advisories).

---

## 🔑 Commit & Tag Signatures

Every release tag and maintainer commit is SSH-signed (`gpg.format=ssh`); GitHub shows the Verified badge on them. Automated Dependabot / CI commits are not signed with the maintainer key (GitHub signs these with its own), so verify a signed release tag — the artifact a release consumer trusts:

```bash
echo "* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtqTWGKhX1Dk9nZP8ns13Wl5zsO1Cz3VlTS6m1p2fP9" > coalhearth_signers
git config gpg.ssh.allowedSignersFile ./coalhearth_signers
git tag -v "$(git describe --tags --abbrev=0)"
```

## 📦 Dist Integrity
- **`plugin/` is generated, never hand-edited** — it's the Claude Code distribution the marketplace serves.
- **`scripts/verify.mjs` compares dist against source in both directions** — byte-exact, with a CRLF/LF-normalized fallback on text files only (so a checkout's line-ending doesn't false-flag byte-identical content) — a stale dist and a dist-only orphan both fail the gate.
- **`scripts/build-plugin.mjs` reproduces `plugin/` from source; `scripts/test.mjs` runs the zero-dependency suite** — a cloner reproduces the exact shipped bytes with `node scripts/build-plugin.mjs && node scripts/verify.mjs`.

<!-- version-transition: SkillSpector scan—the re-scan is automatic on one event (E2: this repo's own version bump, gated by a per-repo baseline diff); a genuinely new attack surface is a second, by hand. (E1, a weekly new-SkillSpector-version watcher, was retired on the owner's word on 2026-09-26.) Record the version/score/date/commit here only after a real scan. Last run: SkillSpector main commit 5cb9385 (self-reported v2.12.0; not a release tag) · CoalHearth v2.8.10 (dist v2.8.10, commit 153c957) · 2026-11-05 · 11 findings, all the same as the 2.8.9 record's. Line refs drift on skill edits—verify against the fresh scan output. (This file is at the repo root, OUTSIDE the scanned plugin/ dir, so this comment is not scanned.) -->
## 🔬 Independent Scanning—NVIDIA SkillSpector

Last scan: CoalHearth **v2.8.10** dist (`plugin/`, commit `153c957`), on **2026-11-05**, with [NVIDIA SkillSpector](https://github.com/NVIDIA/skillspector) at main commit `5cb9385ab0dffa974088ee21c4376c7e560b2a52` (self-reported version string v2.12.0; not a release tag). Run locally through `uvx`, nothing installed, static stage only (`--no-llm`). **Score 100/100 (CRITICAL). 11 findings, 0 real.** Static coverage is partial: 19 of 23 files fully inspected; the four not fully inspected are `bin/ag-pre-invocation.js`, `bin/user-prompt-submit.js`, `lib/resume-engine.js` and `hooks/hooks.json`.

- **`TM1` ×1:** a source comment that records a fixed path-containment bug; the plugin has no command-execution primitive.
- **`RA1` ×7:** the word "self-update" in comments and in the consent-gated update offer; nothing installs by itself.
- **`EA2` ×2:** the phrase "no consent" in a sentence that says no consent step exists.
- **`BH1` ×1:** a notice that `hooks/hooks.json` registers lifecycle hooks, not a defect.

Earlier scans, and the reason for each finding, are in this file's git history (`git log -- SECURITY.md`); scanning is event-driven, not per release.

## 🛡️ Structural Safety (Phoenix-13)

The hooks are zero-dependency, make no network call, start no child process, fail silent, and only advise the agent. No data-exfiltration path.

### Attack surface
- **Zero dependencies** — no third-party packages, so no dependency-CVE surface (nothing to `npm audit`; the lockfile-scan step other projects need is N/A here).
- **No network** — the engine is entirely local filesystem; it never makes a network request.
- **Node builtins only** — `fs`, `path`, `os`. **No child processes** — the hooks spawn nothing (the earlier best-effort `git status` spawn was removed; modified files come from the tool-call payloads the hook observes).

### Hook safety
- The `SessionStart`, `PostToolUse`, and `UserPromptSubmit` (Claude Code only, `bin/user-prompt-submit.js`, issue #13) hooks — and their multi-platform adapters (`bin/ag-pre-invocation.js`, `bin/ag-post-tool-use.js`, thin shims over the same shared core, argv-switched per platform: Antigravity / Gemini CLI / Copilot CLI / Devin CLI / Kiro / Augment) — are **fail-silent**: all logic is wrapped in try/catch, they exit 0 on every path, and they never crash the host agent.
- The only output is the sanctioned context injection. On Claude Code, SessionStart carries the recovery block, the update nudge, the language-lock and config notices, and a warning when the journal folder cannot be created; UserPromptSubmit carries the subagent note; all as plain stdout. On the CC-shaped file-copy platforms, plain stdout; on Antigravity, `bin/ag-pre-invocation.js` emits one `{"injectSteps":[{"ephemeralMessage":...}]}` JSON line, and `bin/ag-post-tool-use.js` prints nothing (both run from the native plugin's `hooks.json`, each with a 10-second timeout, adding no new capability); on Gemini CLI, one nested `{"hookSpecificOutput":{"additionalContext"}}` line. On these three the output carries the recovery block or the journal-folder warning. Nothing else is written to stdout/stderr.

## Security by Design — the Journal

### Filesystem safety
- **Path-contained orphan sweep.** The resume-time sweep removes a worker folder or probe file only when a trusted registry in the Claude config folder names it (`coal/coalhearth/owned-artifacts.json`, `~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise). The registry is read bounded and fails closed to nothing. No part of CoalHearth writes it yet, so the sweep removes nothing today. Its candidates are the `scratch` and `worktrees` folders under `.claude/coalhearth` and `.agents/coalhearth`; each must resolve to exactly its literal location under the workspace root, so a link planted at one of them makes the sweep skip it. It never touches the user's own tree (e.g. your `scripts/`) and never does a blind recursive delete.
- **Contained journal directory.** `journal.outputDirectory` (since 2.7.0 read from the global config only; a project `.coalhearth.json` value is ignored) is realpath-contained under the workspace root at construction — a path escaping the workspace (e.g. `"../../victim"`) clamps to the default owned dir, so neither the journal write, the ENOSPC prune, nor the corrupt-quarantine can be aimed outside. The helper is `containedOutputDir` in `lib/contained-dir.js`: it resolves the project root and the candidate with `fs.realpathSync.native` (through the nearest existing directory), skips a candidate whose real path lies outside the root, and returns nothing when none passes. For the default `.claude/coalhearth/` it is stricter: the folder is refused, each time a hook builds the journal (every tool call), unless its real path is exactly `<project root>/.claude/coalhearth`, so a link planted at it, or at `.claude` above it, leaves the journal with no directory that session; only the default folder also gets its own self-ignoring `.gitignore`. A `journal.outputDirectory` set in the global config is contained to the project root only, not pinned to that folder, and the journal still writes there. The ENOSPC prune (`HandoffJournal._pruneOldLogs`) deletes only `error.log` and `*.tmp` files, and only inside the project root's own `.claude/coalhearth` (`isOwnedDefaultDir`, checked against the project root, so not a same-named folder elsewhere), whatever `outputDirectory` is. The orphan sweep (`ResumeEngine.sweepOrphans`) does not go through it: it has its own check, and it removes a path only when the trusted registry above names that path, its folder's real path equals its literal location in `scratch` or `worktrees`, and the path resolves inside the project.
- **Bounded, contained reads.** Every file a cloned repository can plant (the project and global config, the journal, `AGENTS.md`, `task.md`, the update stamp) is read through one reader (`lib/repo-fs.js`): a FIFO, device, socket, or a link that escapes is refused before it is opened, a dangling link reads as absent, and a file over its bound (configs 1 MiB, the journal and `AGENTS.md`/`task.md` 4 MiB, the stamp 1 KiB) is skipped and never truncated. A project file reached through a link must be a file in its own folder inside the project (since v2.8.6; before it, anywhere inside the project); a link at any folder between the project root and a project config file (`.claude`, `.claude/coal`) is refused wherever it points (since v2.8.5). The journal's three reads also ask the journal folder's pin first (since v2.8.3), so a link swapped in at the folder after the journal was built is not read. The global config and the stamp, which dotfile managers legitimately link, get the kind check and the bound without the containment.
- **Atomic journal writes** (an exclusive temp-write + rename, with retry/backoff: a link planted at the temp name is replaced, never written through); a corrupt journal is quarantined aside rather than crashing the boot; the writer keeps the journal under the reader's 4 MiB bound by dropping its oldest recorded paths, then its oldest subagent records, past that size, and it records how many it dropped (if it still cannot fit, nothing new is written and the last good journal stays); a journal over the bound that this tool did not write is not read and is replaced by a fresh one on the next recorded step; a disk-quota error prunes old logs and keeps the core state.

### Config parsing
- The `.coalhearth.json` read is bounded and contained (see "Bounded, contained reads" above). `scripts/configure.mjs` refuses a config that is over 1 MiB, not a regular file, or reached through a link that leaves the project or through a link at a folder above it (since v2.8.5), or a file link at the config path whose target is outside the file's own folder (since v2.8.6), and writes the config and its `.bak` through an exclusive temp renamed into place.
- The `.coalhearth.json` parse is **prototype-pollution-guarded** — `__proto__` / `constructor` / `prototype` keys are dropped at parse time, so an untrusted project config (e.g. one shipped by a cloned repo) cannot pollute `Object.prototype` through the config merge.

### Honest scope
CoalHearth **reduces** the damage of a session limit-hit; it does not prevent one or guarantee recovery (the recovery block always instructs verification against git — the journal may be stale). External scan provenance is recorded in "Independent Scanning" above.
