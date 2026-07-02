---
description: CoalHearth self-update — check for a newer version and offer to apply it, or set how updates are handled.
---

Kind-1 self-update — the **agent** verifies (online), the **hook** only schedules (it never networks). On an offline box or with no git, say so and skip gracefully.

1. **Check.** Compare the latest published tag to the installed version:
   - latest tag: `git ls-remote --tags --sort=-v:refname https://github.com/TheColliery/CoalHearth` → the top `vX.Y.Z` (filter at the source — do not fetch the whole list).
   - installed: the `version` in `.claude-plugin/plugin.json`.
2. **Offer (consent-gated — the only token spend).** Newer available → OFFER `claude plugin update coalhearth@coalhearth` (then restart). Already current → say so in one line.
3. **Cadence.** To change how updates are handled, set `update.updateMode` (`ask` | `auto` | `remind` | `off`) and `update.updateCheckDays` in `.coalhearth.json`. `auto` lets this check run when due without re-asking; `off` silences it entirely.

This is orthogonal to the journal/resume hooks (their own config groups) and never auto-applies — it offers, the user runs the update.
