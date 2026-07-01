#!/usr/bin/env node
// CoalHearth PostToolUse hook (COALHEARTH_BLUEPRINT.md §4B). Phoenix-13: fail-silent
// (all logic in one try/catch, never throw out), zero-dep (node builtins only), no
// network, no process.exit() (would truncate the sanctioned stdout channel — none
// is sanctioned here beyond the advisory nudge below, but the rule still holds).
//
// Flow: load config -> build the state snapshot (task.md/AGENTS.md/git, best-effort)
// -> HandoffJournal.save() it atomically (the recovery core — this is the part that
// matters) -> BudgetTracker advisory nudge if near-limit (secondary, best-effort).
'use strict';

try {
  const { loadConfig } = require('../lib/load-config.js');
  const { buildStateSnapshot } = require('../lib/state-snapshot.js');
  const { HandoffJournal } = require('../lib/handoff-journal.js');
  const { BudgetTracker } = require('../lib/budget-tracker.js');

  const cfg = loadConfig();

  const journal = new HandoffJournal(cfg.journal || {});
  const state = buildStateSnapshot(process.cwd());
  journal.save(state);

  const tracker = new BudgetTracker(cfg.budgets || {});
  tracker.incrementTurn();
  try {
    const raw = require('node:fs').readFileSync(0, 'utf8');
    if (raw) tracker.estimateFromChars(raw, true);
  } catch {
    // no stdin payload to estimate from -- the turn-count signal alone still works
  }

  const analysis = tracker.evaluateLimits();
  if (analysis.shouldBlockSpawning) {
    // Advisory only (best-effort char-heuristic) -- never a hard block; the model
    // decides whether to actually collapse to inline-self.
    process.stdout.write(`[CoalHearth] ${analysis.reason} (advisory, best-effort estimate) -- prefer inline over spawning subagents.`);
  }
} catch {
  // Phoenix #4: fail-silent, never crash the host.
}
