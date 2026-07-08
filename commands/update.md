---
description: CoalHearth self-update — check for a newer version and offer to apply it, or set how updates are handled.
---

Kind-1 self-update — the **agent** verifies (online), the **hook** only schedules (it never networks). If git/network is unavailable, say so and suggest updating manually later (never assume either exists).

1. **Check.** Web-check the latest published CoalHearth tag (any means available — the GitHub releases/tags page or API; `git ls-remote --tags` works too when git exists) vs the installed `version` in `.claude-plugin/plugin.json`.
2. **Offer (consent-gated — the only token spend).** Newer available → OFFER `claude plugin update coalhearth@coalhearth` (then restart). Already current → say so in one line.
3. **Cadence.** To change how updates are handled, set `update.updateMode` (`ask` | `auto` | `remind` | `off`) and `update.updateCheckDays` in `.coalhearth.json`. `auto` lets this check run when due without re-asking; `off` silences it entirely.

This is orthogonal to the journal/resume hooks (their own config groups) and never auto-applies — it offers, the user runs the update.
