---
description: CoalHearth self-update — check for a newer version and offer to apply it, or set how updates are handled.
---

Kind-1 self-update — the **agent** verifies (online), the **hook** only schedules (it never networks). If git/network is unavailable, say so and suggest updating manually later (never assume either exists).

1. **Check.** Web-check the latest published CoalHearth tag (any means available — the GitHub releases/tags page or API; `git ls-remote --tags` works too when git exists) vs the installed `version` in `.claude-plugin/plugin.json`.
2. **Offer (consent-gated — the only token spend).** Newer available → OFFER `claude plugin update coalhearth@coalhearth` (then restart). Already current → say so in one line.
3. **Cadence.** To change how updates are handled, set `update.updateMode` (`ask` | `auto` | `remind` | `off`) and `update.updateCheckDays` in your CoalHearth config — see README's Configure section for where that lives (a project's own agent-dir config is read first; the legacy `.coalhearth.json` shapes are deprecated). The hook tells only `off` from the rest: `off` silences the check entirely, while `ask`, `auto` and `remind` all behave the same today (when the check is due, the hook prints one consent-gated offer, and it does not pass the mode to the agent). A project config may only quieten `update.updateMode` (loudest to quietest: `auto`, `ask`, `remind`, `off`): the quieter of the two values wins, so a project can never re-enable a global `off`, and with no global config the default `ask` stands in for it.

**On Antigravity** the plugin is installed by `agy plugin install https://github.com/TheColliery/CoalHearth.git`, not by Claude Code's plugin manager, so `claude plugin update` does not apply there. Measured 2026-10-08 on `agy` 1.3.1: that command exited 0, cloned the whole repository to `~/.gemini/config/plugins/coalhearth/` and imported the commands as skills. Whether the hooks then fire from that folder, and what a re-install over an existing install does, were NOT measured.

This is orthogonal to the journal/resume hooks (their own config groups) and never auto-applies — it offers, the user runs the update.
