# Contributing to CoalHearth

CoalHearth is the session warm-resume engine of the [TheColliery](https://github.com/TheColliery) series. We welcome issues, bug reports, and pull requests.

---

## 🤝 Proposing a Change

1. **Open an issue first** describing the problem, gap, or proposed feature (especially for hook-behavior changes — the hooks run inside every session).
2. Make your code changes and keep the verification gates green.
3. For hook or recovery-block changes, **validate against the hermetic fake-case suite** (`scripts/lib/hooks.test.mjs` simulates all the limit-hit failure modes) and, where you can, a real interrupted session — then document the behavior in your PR.

---

## 💻 Developing & Testing

CoalHearth is **zero-dependency** (Node.js built-ins only, Node 22+). No `npm install` and no `package.json` — the gates run directly:

```bash
node scripts/build-plugin.mjs   # regenerate plugin/ from source
node scripts/verify.mjs         # gate: manifests, factory config vs schema, config-key drift, pointer drift, git-spawn census, dist-sync, version pins
node scripts/test.mjs           # zero-dependency test suite (node --test, explicit file list)
```

### Development Rules
* **Rebuild the dist after a source change:** edit `bin/`, `lib/`, `config/`, `hooks/`, `commands/`, or the manifest, then `node scripts/build-plugin.mjs` to re-sync `plugin/` (verify fails on a stale dist).
* **`scripts/lib/config-schema.mjs` is the single source of truth** for every `.coalhearth.json` key — `verify.mjs` validates the factory config against it; the runtime `config/schema.json` mirrors it.
* **A git child takes its environment from `gitEnv()` alone** (`scripts/lib/git-env.mjs`): a git hook exports an absolute `GIT_DIR`, and a gate or test fixture that inherits it acts on the wrong repository. The census in `verify.mjs` fails a git spawn whose `env:` is anything other than `gitEnv(...)` alone — the whole expression, or a `const` assigned from exactly that call and not mutated (a spawn with no `env:`, any mention of `process.env`, `env || gitEnv(x)` and a spread beside another object all fail). Git through a shell or a binary not spelled `git` counts as a git spawn. One spawn is exempt by name, counted and printed (`scripts/lib/git-env.test.mjs`, the hazard proof). Each exemption states how many spawns it covers: one more fails the gate, one fewer is stale and fails it too. The census is textual and its header in `scripts/lib/git-env-census.mjs` names what it cannot see, including a `shell:` call whose arguments are a variable rather than an array literal.
* **Keep the hooks Phoenix-pure:** zero dependencies, fail-silent (wrap in try/catch, exit 0, never `process.exit()`), no network, silent except the sanctioned channels.
* **Add tests:** every lib change gets a unit test; every hook-behavior change gets a **hermetic spawn test** (spawn the real hook, sandbox TEMP + HOME). Register a new test *file* in `scripts/test.mjs` (the runner fails on an unlisted orphan).
* **Language & tone:** shipped source and docs stay in English.

### What CI does on a docs-only change

Both required checks — `all-green` (CI) and `analyze (javascript)` (CodeQL) — **always run**, on
every push. A change touching only non-shipped docs still reports them green, and each workflow
writes a **job summary saying plainly that nothing ran**: no dist-sync check, no tests, no CodeQL
query, no SARIF. Read that as *"there was nothing to check"*, never as *"the checks passed"* — in
the checks list the two are indistinguishable, and the summary is the only place they differ.

The two filters are deliberately **not** the same width. CodeQL skips every `.md`; CI skips only
the six non-shipped root docs, because a **shipped** markdown file (`commands/*.md`) reaches
`plugin/` and must still pass the dist-sync gate. Widening either one to match the other silently
drops coverage.

A third workflow, `link-check`, is **NOT a required check** — it isn't in the branch ruleset —
but it still runs on every push and pull request, docs-only or not, and it does real work: it
walks every tracked `.md` file outside `plugin/` (the generated dist copy) and
`scripts/fixtures/` (the engine's own planted-defect test fixtures), and fails on a broken
internal link or a heading anchor that doesn't resolve. There's no `paths:` filter on it (most of this room's citations point at
non-markdown targets, so a filter scoped to `.md` would miss the change that breaks them), so a
docs-only push doesn't get a free pass from `link-check` the way it does from CI and CodeQL — a
broken link in the very doc you're editing goes red on this check, even though it can't block a
merge on its own.

A fourth workflow, `coverage`, is **report only** — not a required check, no threshold, and it
can't block a merge — and it too runs on every push and pull request with no `paths:` filter,
docs-only or not. Unlike the two required checks it does **not** report "nothing ran": on a
docs-only push it still runs the **whole test suite** (every `*.test.mjs`, `*.test.cjs` and
`*.test.js` on disk, under Node's experimental coverage flag) and publishes one line-coverage
report, which GitHub shows as a coverage comment on a pull request. A red run there is a real
failure to fix — a test broke — not a gate. Its upload step is `fail-on-error: false`, so a
refused upload (say, Code Quality isn't switched on for the repository) shows as an `::error::`
annotation inside a green run, not a red one.

---

## 🖥️ Supported Platforms

CoalHearth is **hook-only by design** — the hooks ARE the product (a session-start-class event = resume, a per-tool event = journal). It runs wherever a platform ships that event **pair**: Claude Code (validated, plugin) plus the works-with config-only ports — Antigravity, Gemini CLI, Copilot CLI, Devin CLI, Kiro, Augment (see the README compat matrix and [`platform-configs/hooks/`](platform-configs/hooks/)). There is no skill directory to port: without a hook lifecycle there is nothing left to run, and a platform missing half the pair (session-start only, or per-tool only) cannot carry the product. If a platform ships the pair and isn't in the matrix, open an issue.

---

## 🗂️ Project Layout

| Path | Purpose |
|---|---|
| `bin/` | Hook entrypoints: `session-start.js` (resume + self-update schedule) · `post-tool-use.js` (journal). |
| `lib/` | Core (CJS, required by the hooks): `handoff-journal`, `resume-engine`, `state-snapshot`, `journal-step`, `load-config`. |
| `config/schema.json` | Draft-07 JSON-Schema mirror of the config (derived from `scripts/lib/config-schema.mjs`). |
| `hooks/hooks.json` | Hook wiring via `${CLAUDE_PLUGIN_ROOT}/bin/…`. |
| `commands/update.md` | The `/coalhearth:update` self-update procedure (agent-side; the hook only schedules). |
| `commands/stats.md` | The `/coalhearth:stats` measurement command (read-only journal/resume report). |
| `scripts/` | Tool scripts: `build-plugin.mjs`, `verify.mjs`, `test.mjs`, `lib/` (ESM logic + hermetic tests). |
| `plugin/` | Generated Claude Code plugin distribution — never hand-edit. |
| `platform-configs/.coalhearth.json` | Commented factory default configuration. |

---

## 🚀 Releasing (Maintainers)

Bump version in `.claude-plugin/plugin.json` ➡️ add a `CHANGELOG.md` entry ➡️ ensure `verify.mjs` and `test.mjs` pass ➡️ commit ➡️ create a signed git tag (`vX.Y.Z`) ➡️ push ➡️ create a GitHub Release (stable tags only; a beta launch gets a prerelease).

---

## 📄 License & Conduct

Contributions are licensed under the [Apache License 2.0](LICENSE). Please assume good faith and be respectful. Report security issues per [SECURITY.md](SECURITY.md).
