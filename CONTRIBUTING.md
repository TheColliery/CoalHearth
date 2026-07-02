# Contributing to CoalHearth

CoalHearth is the session warm-resume + budget-guardrail engine of the [TheColliery](https://github.com/TheColliery) series. We welcome issues, bug reports, and pull requests.

---

## 🤝 Proposing a Change

1. **Open an issue first** describing the problem, gap, or proposed feature (especially for hook-behavior changes — the hooks run inside every session).
2. Make your code changes and keep the verification gates green.
3. For hook or recovery-block changes, **validate against the hermetic fake-case suite** (`scripts/lib/hooks.test.mjs` simulates all the limit-hit failure modes) and, where you can, a real interrupted session — then document the behavior in your PR.

---

## 💻 Developing & Testing

CoalHearth is **zero-dependency** (Node.js built-ins only, Node 18+). No `npm install` and no `package.json` — the gates run directly:

```bash
node scripts/build-plugin.mjs   # regenerate plugin/ from source
node scripts/verify.mjs         # gate: manifests, factory config vs schema, dist-sync, version pins
node scripts/test.mjs           # zero-dependency test suite (node --test, explicit file list)
```

### Development Rules
* **Rebuild the dist after a source change:** edit `bin/`, `lib/`, `config/`, `hooks/`, `commands/`, or the manifest, then `node scripts/build-plugin.mjs` to re-sync `plugin/` (verify fails on a stale dist).
* **`scripts/lib/config-schema.mjs` is the single source of truth** for every `.coalhearth.json` key — `verify.mjs` validates the factory config against it; the runtime `config/schema.json` mirrors it.
* **Keep the hooks Phoenix-pure:** zero dependencies, fail-silent (wrap in try/catch, exit 0, never `process.exit()`), no network, silent except the sanctioned channels.
* **Add tests:** every lib change gets a unit test; every hook-behavior change gets a **hermetic spawn test** (spawn the real hook, sandbox TEMP + HOME). Register a new test *file* in `scripts/test.mjs` (the runner fails on an unlisted orphan).
* **Language & tone:** shipped source and docs stay in English.

---

## 🖥️ Supported Platforms

CoalHearth is **Claude Code only, by design** — the hooks ARE the product (`SessionStart` = resume, `PostToolUse` = journal), and other agent platforms do not run Claude Code hooks. There is no skill directory to port: without the hook lifecycle there is nothing left to run. If another platform ships a compatible hook system, open an issue.

---

## 🗂️ Project Layout

| Path | Purpose |
|---|---|
| `bin/` | Hook entrypoints: `session-start.js` (resume + self-update schedule) · `post-tool-use.js` (journal + budget nudge). |
| `lib/` | Core (CJS, required by the hooks): `handoff-journal`, `resume-engine`, `state-snapshot`, `budget-tracker`, `load-config`. |
| `config/schema.json` | Draft-07 JSON-Schema mirror of the config (derived from `scripts/lib/config-schema.mjs`). |
| `hooks/hooks.json` | Hook wiring via `${CLAUDE_PLUGIN_ROOT}/bin/…`. |
| `commands/update.md` | The `/coalhearth:update` self-update procedure (agent-side; the hook only schedules). |
| `scripts/` | Tool scripts: `build-plugin.mjs`, `verify.mjs`, `test.mjs`, `lib/` (ESM logic + hermetic tests). |
| `plugin/` | Generated Claude Code plugin distribution — never hand-edit. |
| `platform-configs/.coalhearth.json` | Commented factory default configuration. |

---

## 🚀 Releasing (Maintainers)

Bump version in `.claude-plugin/plugin.json` ➡️ add a `CHANGELOG.md` entry ➡️ ensure `verify.mjs` and `test.mjs` pass ➡️ commit ➡️ create a signed git tag (`vX.Y.Z`) ➡️ push ➡️ create a GitHub Release (stable tags only; a beta launch gets a prerelease).

---

## 📄 License & Conduct

Contributions are licensed under the [MIT License](LICENSE). Please assume good faith and be respectful. Report security issues per [SECURITY.md](SECURITY.md).
