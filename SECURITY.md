# Security Policy

CoalHearth is a zero-dependency, hook-pair-keyed plugin — validated on Claude Code, works with 6 other platforms (Antigravity, Gemini CLI, Copilot CLI, Devin CLI, Kiro, Augment). Its security posture:

## Reporting
Report a security issue in this repo through GitHub's private vulnerability reporting — [Security → Report a vulnerability](https://github.com/TheColliery/CoalHearth/security/advisories/new) — never a public issue. In scope: the shipped hooks (`bin/session-start.js`, `bin/post-tool-use.js`, `bin/user-prompt-submit.js`, and the Antigravity/config-only adapters), the `lib/` journal + resume core, the installer and other `scripts/`, and the `plugin/` dist built from them. Out of scope: a vulnerability in a project's own rules/config file that CoalHearth merely reads as untrusted data (a hostile `AGENTS.md` or `.coalhearth.json`) — that is the project's own security question, not this tool's. This is a one-person-maintained project: expect the report to be read and acknowledged, triaged against the scope above, and disclosed once a fix ships, with no fixed response-time SLA. A public GitHub issue remains the right channel for an ordinary, non-security bug.

---

## Security Advisories

### CWK-137: a cloned repository could hang CoalHearth or make it write or delete outside the project through a planted link (2026-10-03)

**What an attacker needs.** A repository you clone that carries a planted symbolic link (on Windows, a junction or symlink), FIFO or device file at a path CoalHearth reads, writes or deletes. That is the whole precondition: no other access. The hooks fire on ordinary session events in that clone; `scripts/configure.mjs` acts only when you run it there. **No CVE id is claimed; none exists.** Found by the sibling CoalMine's security review (2026-09-24) and swept into this repo.

**Affected versions.** Every release from **v0.1.0-beta.1** (the first tag) through **v2.6.0**, the latest tag. The `plugin.json` versions, the CHANGELOG headings and the tags agree (31 versions, none untagged), and the per-defect first versions below come from `git log -S` on the unsafe call sites and the first tag that contains each commit. **Fixed in:** the repository, commits `f678ca3`, `7963da5`, `3abeff9` and `27a8aae`; they are not in a release yet, so the next release after v2.6.0 ships them, and this entry will name that version when it does. Until then, do not run a CoalHearth hook or `scripts/configure.mjs` in a clone you do not trust.

#### 1. The hooks read a planted path with no bound

| | |
|---|---|
| **What happens** | The SessionStart and PostToolUse hooks read the project config, the global config, the journal, `AGENTS.md`, `task.md` and the update stamp with a plain read. A file over any size was read whole, and a link at the project config that led out of the project was followed. A link to `/dev/zero` at one of these paths allocates until the process dies, and a FIFO blocks the hook. **Measured on Windows (the fix's red runs):** a config one byte over 1 MiB was read whole, a junction out of the project was followed, and an over-size journal, `AGENTS.md`, `task.md` and update stamp were read whole. **Not measured by us:** the FIFO and `/dev/zero` cases. Their tests skip on Windows and run on the Linux and macOS CI legs; on the old code they follow from the plain read. Nothing is disclosed and no file is changed: the hook dies, hangs or exhausts memory. |
| **First affected** | The project config, `AGENTS.md`, `task.md` and the journal read at resume: **v0.1.0-beta.1**. The update stamp: **v0.1.0-beta.2**. The journal read in `lib/handoff-journal.js`: **v0.1.0-beta.6**. The global config also had no kind check at all. |

#### 2. The journal temp file was written through a planted link

| | |
|---|---|
| **What happens** | The journal is saved by writing a temp file next to it and renaming it into place. A link planted at the temp name was followed: the journal's bytes landed in the link target, outside the project. The bytes are the journal's own JSON (goal, checklist and constraint text, modified-file paths, a transcript path), not attacker-chosen text. The same write was used for the corrupt-journal quarantine and the resumed marker. Measured on Windows with a hard link at the temp name (the fix's red run). |
| **First affected** | **v0.1.0-beta.1**, where the temp name was the fixed `session_handoff.json.tmp`. From **v2.0.0** the name carries the writer's process id, so a planter has to guess it. |

#### 3. The legacy-phantom clean-up deleted through a planted link

| | |
|---|---|
| **What happens** | When a session starts in a subdirectory of a project, CoalHearth removes a stray `.claude/coalhearth` directory its older versions may have left under that subdirectory. A junction or symlink at that path, or at `.claude` above it, made the removal land in the link target: it deleted files named `session_handoff*` and `.gitignore` there, then tried to remove the directory (which fails if anything else remains). It never deleted a file with any other name. Measured on Windows with a junction at the leaf and with `.claude` itself linked. |
| **First affected** | **v2.1.1**. |

#### 4. `configure.mjs` read, backed up and overwrote through a planted link

| | |
|---|---|
| **What happens** | With a link at the project config path, `scripts/configure.mjs` treated what it found as an existing config, backed it up to `<file>.bak` and overwrote it. A hard link at the config path or at the `.bak` path, or a directory link at `.claude` that led out of the project, made those writes land outside the project. It also read an existing config of any size. Measured on Windows (the fix's red runs). |
| **First affected** | **v2.5.0**, the first tag that contains the script. It is a repo script, not part of the plugin dist, and acts only when you run it. |

**What the fix does.** Every read of a repo-derived path now goes through one reader (`lib/repo-fs.js`). It checks the kind first: a regular file proceeds, and a symlink proceeds only when its target lies inside the project and is a regular file. A FIFO, device, socket, directory, or a link that escapes or dangles is skipped before it is opened. The open is non-blocking, the descriptor is re-checked, and a file over its bound is skipped, never truncated: configs 1 MiB, the journal and `AGENTS.md`/`task.md` 4 MiB, the update stamp 1 KiB. The global config and the stamp, which dotfile managers legitimately link, get the kind check and the bound but no containment. The journal temp is created exclusive (`wx`), so a link at its name is replaced, never written through. The clean-up deletes only when the directory's real path is the path it built, so a link anywhere in it leaves everything untouched. `configure.mjs` refuses (exit 1, nothing written) when the existing config is over 1 MiB, outside the project through a link, or a special file, and writes the config and its `.bak` through an exclusive temp renamed into place. An over-size journal is skipped and left in place, never quarantined. **Not covered, named:** a regular file swapped in between the check and the open may lie outside the project (the descriptor re-check still holds the read to a bounded regular file); a link that redirects to another directory inside the project is honored; `configure.mjs --global` keeps its follow-through write to `~/.claude/.coalhearth.json`, because dotfile managers link that file, and its read is bounded. The maintainer and CI scripts (`scripts/verify.mjs`, `scripts/build-plugin.mjs`, `scripts/lib/link-check.mjs`, `scripts/test.mjs`) read this repository's own tracked tree without that bound; no hook and no end-user path runs them.

**What to check if you ran CoalHearth in a clone you did not write.**
- A stray `.bak` beside a config: `<project>/.claude/coal/coalhearth.json.bak`, `<project>/.claude/.coalhearth.json.bak` or `<project>/.coalhearth.json.bak`. Its contents are the file the config path was linked to, not a config. Delete it and do not commit it.
- A file that is not yours with the journal's JSON in it (goal and checklist text, file paths). The journal lives at `<project>/.claude/coalhearth/session_handoff.json`; look for `session_handoff.json.tmp` or `session_handoff.json.<number>.tmp` links there, and check any path they point to.
- Missing `session_handoff*` or `.gitignore` files in a directory outside the project that a link in the clone pointed at.
- Links in a clone you already ran a tool in: `find . -not -path './.git/*' \( -type l -o -type p \)` (POSIX) or `Get-ChildItem -Recurse -Force | Where-Object { $_.Attributes -band 'ReparsePoint' }` (PowerShell). A link at a path CoalHearth reads or writes is the tell.

---

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
