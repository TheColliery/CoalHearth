// CoalHearth BudgetTracker.
// ADVISORY ONLY: a best-effort char-heuristic (4 chars/tok ASCII, 1.5 non-ASCII),
// NOT a precise or guaranteed limit read — never treat evaluateLimits() as a
// hard promise. Real budget enforcement is the platform's; this only nudges
// fan-out decisions earlier than a hard crash would. Contract (see
// COALHEARTH_BLUEPRINT.md §3A):
//   new BudgetTracker(config).incrementTurn()
//   new BudgetTracker(config).estimateFromChars(text, isInput) -> n
//   new BudgetTracker(config).evaluateLimits() -> {limitReached, shouldBlockSpawning, reason}
class BudgetTracker {
  constructor(config = {}) {
    this.maxTurns = config.maxTurns || 30;
    this.maxTokens = config.maxTokens || 2000000;
    this.warningTurnThreshold = config.warningTurnThreshold || 5;
    this.warningTokenPercent = config.warningTokenPercentage || 0.15;
    this.currentTurns = 0;
    this.estimatedTokensUsed = 0;
  }

  incrementTurn() {
    this.currentTurns++;
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
    const turnsRemaining = this.maxTurns - this.currentTurns;
    const tokenPercentageRemaining = 1 - (this.estimatedTokensUsed / this.maxTokens);

    const nearTurnLimit = turnsRemaining <= this.warningTurnThreshold;
    const nearTokenLimit = tokenPercentageRemaining <= this.warningTokenPercent;

    return {
      limitReached: turnsRemaining <= 0 || tokenPercentageRemaining <= 0,
      shouldBlockSpawning: nearTurnLimit || nearTokenLimit,
      reason: nearTurnLimit
        ? `Only ${turnsRemaining} turns remaining.`
        : nearTokenLimit
          ? `Estimated token headroom is ${Math.round(tokenPercentageRemaining * 100)}%.`
          : 'OK'
    };
  }
}

module.exports = { BudgetTracker };
