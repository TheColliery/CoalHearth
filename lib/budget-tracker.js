// CoalHearth BudgetTracker.
// ADVISORY ONLY: a best-effort char-heuristic (4 chars/tok ASCII, 1.5 non-ASCII),
// NOT a precise or guaranteed limit read — never treat evaluateLimits() as a
// hard promise. Real budget enforcement is the platform's; this only nudges
// fan-out decisions earlier than a hard crash would.
//
// TOKEN-ONLY (audit 2026-07-02 MED): the former turn-tracking branch was
// structurally dead — the hook constructs a fresh tracker each PostToolUse
// (Phoenix #6, stateless) so currentTurns could never exceed 1 and the turn
// nudge could never fire on the default path. YAGNI-removed with its config
// keys (maxTurns / warningTurnThreshold — tombstoned in scripts/lib/config-schema.mjs).
// Contract (supersedes COALHEARTH_BLUEPRINT.md §3A's turn+token sketch):
//   new BudgetTracker(config).estimateFromChars(text, isInput) -> n
//   new BudgetTracker(config).evaluateLimits() -> {limitReached, shouldBlockSpawning, reason}
class BudgetTracker {
  constructor(config = {}) {
    this.maxTokens = config.maxTokens || 2000000;
    this.warningTokenPercent = config.warningTokenPercentage || 0.15;
    this.estimatedTokensUsed = 0;
  }

  // isInput is accepted for API-contract symmetry (input vs output chunks may
  // get separate accounting later); the char-heuristic itself doesn't need it.
  estimateFromChars(text, isInput = true) {
    const charCount = text ? text.length : 0;
    const ratio = /[^\x00-\x7F]/.test(text || '') ? 1.5 : 4.0;
    const estimated = Math.ceil(charCount / ratio);
    this.estimatedTokensUsed += estimated;
    return estimated;
  }

  evaluateLimits() {
    const tokenPercentageRemaining = 1 - (this.estimatedTokensUsed / this.maxTokens);
    const nearTokenLimit = tokenPercentageRemaining <= this.warningTokenPercent;

    return {
      limitReached: tokenPercentageRemaining <= 0,
      shouldBlockSpawning: nearTokenLimit,
      reason: nearTokenLimit
        ? `Estimated token headroom is ${Math.round(tokenPercentageRemaining * 100)}%.`
        : 'OK'
    };
  }
}

module.exports = { BudgetTracker };
