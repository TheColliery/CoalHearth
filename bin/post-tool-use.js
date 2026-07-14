#!/usr/bin/env node
// CoalHearth PostToolUse hook — Claude Code adapter (COALHEARTH_BLUEPRINT.md §4B).
// Phoenix-13: fail-silent (all logic in one try/catch, never throw out), zero-dep
// (node builtins only), no network, NO child processes (Phoenix #5 — the state
// snapshot is pure fs, no git spawn), no process.exit() (would truncate the
// sanctioned stdout channel — none is sanctioned here beyond the advisory nudge).
//
// Thin adapter: the CC hook stdin payload IS the {tool_name, tool_input, tool_response}
// shape lib/journal-step.js parses, so this file just: load config -> read stdin ->
// parseToolPayload -> recordStep (the recovery core) -> emit the advisory budget nudge.
// The Antigravity adapter (bin/ag-post-tool-use.js) shares the same core through the
// same module, differing only in a payload-shape normalizer (one-flock, no fork).
'use strict';

try {
  const { loadConfig } = require('../lib/load-config.js');
  const { parseToolPayload, recordStep } = require('../lib/journal-step.js');

  const cfg = loadConfig();

  let raw = '';
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    // no stdin payload -- the journal save below still works, just with no touched file
  }

  // The PostToolUse payload ({tool_name, tool_input, tool_response, ...}); garbage
  // stdin -> parsed stays empty (no touched file, no spawn), the journal still saves.
  let parsed = {};
  try {
    parsed = parseToolPayload(JSON.parse(raw));
  } catch {
    // not JSON -- nothing to record from the payload
  }

  const analysis = recordStep(process.cwd(), cfg, {
    touchedFile: parsed.touchedFile,
    spawn: parsed.spawn,
    budgetText: raw,
  });
  if (analysis.shouldBlockSpawning) {
    // Advisory only (best-effort char-heuristic) -- never a hard block; the model
    // decides whether to actually collapse to inline-self.
    process.stdout.write(`[CoalHearth] ${analysis.reason} (advisory, best-effort estimate) -- prefer inline over spawning subagents.`);
  }
} catch {
  // Phoenix #4: fail-silent, never crash the host.
}
