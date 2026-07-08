#!/usr/bin/env node
// CoalHearth PostToolUse hook (COALHEARTH_BLUEPRINT.md §4B). Phoenix-13: fail-silent
// (all logic in one try/catch, never throw out), zero-dep (node builtins only), no
// network, NO child processes (Phoenix #5 — the state snapshot is pure fs, no git
// spawn), no process.exit() (would truncate the sanctioned stdout channel — none
// is sanctioned here beyond the advisory nudge below, but the rule still holds).
//
// Flow: load config -> read the hook stdin payload -> build the state snapshot
// (task.md/AGENTS.md + the file THIS tool call touched + any Agent/Task spawn it
// observed, each accumulated onto the prior journal's list, best-effort) ->
// HandoffJournal.save() it atomically (the recovery core — this is the part that
// matters) -> BudgetTracker advisory nudge if the estimated token headroom is low
// (secondary, best-effort).
'use strict';

// Tools whose payload names a file they modify; anything else (Read, Bash, ...)
// contributes no path. Best-effort by design — the recovery block always says
// VERIFY against git, and a Bash-side edit is exactly the staleness it warns about.
const FILE_TOOL_KEYS = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

// The sub-agent spawn tool is `Agent` (legacy alias `Task`); match both so a
// platform/version reporting either is covered (Incident E). `Workflow` is the
// multi-agent orchestration tool — its internal fan-out is invisible to this hook
// (it runs its own journal), but the RUN's existence + residue location is not:
// a limit-hit mid-workflow leaves the run's own journal.jsonl as the recovery
// point, and the resume block must point the next session at it (field evidence
// 2026-07-08: 52-agent workflow, 8 dead on a session limit, zero outer-session record).
const SPAWN_TOOL_NAMES = new Set(['Agent', 'Task', 'Workflow']);

// Extract an in-flight-subagent record from a spawn tool_call payload (Incident E).
// Captures only what the payload GIVES: the `description` + `subagent_type` from
// tool_input (the stable Agent-tool arg schema) and, best-effort, an output/residue
// path IF tool_response carries one under any plausible key (the exact tool_response
// shape is undocumented, so this is probe-not-require — a missing path is normal).
// Returns null for a non-spawn tool. No throw (caller is fail-silent regardless).
function extractSpawn(payload) {
  if (!payload || !SPAWN_TOOL_NAMES.has(payload.tool_name)) return null;
  const inp = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
  const resp = (payload.tool_response && typeof payload.tool_response === 'object') ? payload.tool_response : {};
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  return {
    // Agent/Task carry `description`; Workflow carries `name`/`scriptPath` instead —
    // fall through so a workflow run is journaled by its own identifier.
    description: str(inp.description) || str(inp.name) || str(inp.scriptPath) || '(no description)',
    subagentType: str(inp.subagent_type) || (payload.tool_name === 'Workflow' ? 'workflow' : undefined),
    // Probe a few plausible residue-path keys; undocumented + version-dependent, so
    // best-effort. Absent -> undefined (the recovery block just omits it). For a
    // Workflow the real recovery point is the run's own journal.jsonl/transcript dir.
    outputPath: str(resp.output_file) || str(resp.outputPath) || str(resp.output_path) || str(resp.transcriptDir) || str(resp.scriptPath),
    spawnedAt: new Date().toISOString(),
  };
}

try {
  const { loadConfig } = require('../lib/load-config.js');
  const { buildStateSnapshot } = require('../lib/state-snapshot.js');
  const { HandoffJournal } = require('../lib/handoff-journal.js');
  const { BudgetTracker } = require('../lib/budget-tracker.js');

  const cfg = loadConfig();

  let raw = '';
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    // no stdin payload -- the journal save below still works, just with no touched file
  }

  // The PostToolUse payload ({tool_name, tool_input, tool_response, ...}); garbage
  // stdin -> both stay undefined.
  let touchedFile;
  let spawn;
  try {
    const payload = JSON.parse(raw);
    const key = payload && FILE_TOOL_KEYS[payload.tool_name];
    const p = key && payload.tool_input ? payload.tool_input[key] : undefined;
    if (typeof p === 'string' && p) touchedFile = p;
    spawn = extractSpawn(payload); // an Agent/Task spawn -> an in-flight record (Incident E)
  } catch {
    // not JSON -- nothing to record
  }

  const journal = new HandoffJournal(cfg.journal || {});
  // Accumulate onto the prior save's list ONLY while it is this session's own
  // in-progress journal; a resumed/completed prior journal starts the list fresh.
  const prior = journal.load();
  const sameSession = prior && prior.status === 'in_progress';
  const state = buildStateSnapshot(process.cwd(), {
    priorModifiedFiles: sameSession ? prior.modifiedFiles : [],
    touchedFile,
    priorInFlightAgents: sameSession ? prior.inFlightAgents : [],
    spawn,
  });
  journal.save(state);

  const tracker = new BudgetTracker(cfg.budgets || {});
  if (raw) tracker.estimateFromChars(raw, true);

  const analysis = tracker.evaluateLimits();
  if (analysis.shouldBlockSpawning) {
    // Advisory only (best-effort char-heuristic) -- never a hard block; the model
    // decides whether to actually collapse to inline-self.
    process.stdout.write(`[CoalHearth] ${analysis.reason} (advisory, best-effort estimate) -- prefer inline over spawning subagents.`);
  }
} catch {
  // Phoenix #4: fail-silent, never crash the host.
}
