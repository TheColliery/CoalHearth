# Security Policy

CoalHearth is a zero-dependency Claude Code hook plugin. Its security posture:

## Attack surface
- **Zero dependencies** — no third-party packages, so no dependency-CVE surface (nothing to `npm audit`; the lockfile-scan step other projects need is N/A here).
- **No network** — the engine is entirely local filesystem; it never makes a network request.
- **Node builtins only** — `fs`, `path`, `os`, `crypto`.

## Hook safety (Phoenix-13)
- The `SessionStart` and `PostToolUse` hooks are **fail-silent**: all logic is wrapped in try/catch, they exit 0 on every path, and they never crash the host agent.
- The only output is the sanctioned `SessionStart` context injection (the recovery block); nothing else is written to stdout/stderr.

## Filesystem safety
- **Path-contained orphan sweep.** The resume-time cleanup removes only known scratch/worktree name-patterns, only inside **CoalHearth-owned** dirs (`.claude/coalhearth/scratch`, `.agents/coalhearth/scratch`, and CoalHearth-owned stale worktrees), resolve-and-contained under the workspace root. It NEVER touches the user's own tree (e.g. your `scripts/`) and never does a blind recursive delete.
- **Atomic journal writes** (temp-write + rename, with retry/backoff); a corrupt journal is quarantined aside rather than crashing the boot; a disk-quota error prunes old logs and keeps the core state.

## Config parsing
- The `.coalhearth.json` parse is **prototype-pollution-guarded** — `__proto__` / `constructor` / `prototype` keys are dropped at parse time, so an untrusted project config (e.g. one shipped by a cloned repo) cannot pollute `Object.prototype` through the config merge.

## Honest scope
CoalHearth **reduces** the damage of a session limit-hit; it does not prevent one or guarantee recovery (the recovery block always instructs verification against git — the journal may be stale). As a brand-new plugin (v0.1.0) it has **not** yet been through an external security scan (e.g. SkillSpector); that provenance will be recorded here when it is.

## Reporting
Report a suspected vulnerability by opening an issue on this repository.
