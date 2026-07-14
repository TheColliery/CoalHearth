// CoalHearth PostToolUse shared core — the ONE copy of the journal-step logic both
// the Claude Code hook (bin/post-tool-use.js) and the Antigravity hook
// (bin/ag-post-tool-use.js) route through (one-flock: no forked parsing/save logic;
// a fix here reaches both platforms). Zero-dep, fail-silent (callers wrap in try/catch).
//
// Split of responsibility: each platform adapter NORMALIZES its raw hook payload into
// the Claude-Code payload shape ({tool_name, tool_input, tool_response}); this module
// then parses that shape (parseToolPayload) and records the journal step (recordStep).
// The AG adapter's payload-shape normalizer lives in bin/ag-post-tool-use.js because it
// is AG-specific knowledge (tool-name map + casing), not shared logic.
'use strict';

const { buildStateSnapshot } = require('./state-snapshot.js');
const { HandoffJournal } = require('./handoff-journal.js');
const { BudgetTracker } = require('./budget-tracker.js');

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

// First non-empty string value among `keys` on `obj` (defensive payload reader:
// tolerates the mixed snake_case/camelCase an AG payload carries, and missing keys).
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

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

// Parse a Claude-Code-shaped tool payload into what a journal step needs: the file it
// touched (if a file-editing tool) and an in-flight-subagent record (if a spawn tool).
// Garbage / non-file / non-spawn -> both undefined/null. No throw.
function parseToolPayload(payload) {
  const key = payload && FILE_TOOL_KEYS[payload.tool_name];
  const p = key && payload.tool_input ? payload.tool_input[key] : undefined;
  return {
    touchedFile: (typeof p === 'string' && p) ? p : undefined,
    spawn: extractSpawn(payload),
  };
}

/**
 * Record one journal step: accumulate state onto the prior save and persist it
 * atomically, then return the advisory budget analysis. Never throws (fail-silent).
 * @param {string} cwd workspace root (the caller's process.cwd()).
 * @param {Object} config loaded .coalhearth.json ({journal, budgets}).
 * @param {{touchedFile?: string, spawn?: Object, budgetText?: string}} step
 * @returns {{limitReached:boolean, shouldBlockSpawning:boolean, reason:string}}
 */
function recordStep(cwd, config, step) {
  const journal = new HandoffJournal((config && config.journal) || {});
  // Accumulate onto the prior save's list ONLY while it is this session's own
  // in-progress journal; a resumed/completed prior journal starts the list fresh.
  const prior = journal.load();
  const sameSession = prior && prior.status === 'in_progress';
  const state = buildStateSnapshot(cwd, {
    priorModifiedFiles: sameSession ? prior.modifiedFiles : [],
    touchedFile: step.touchedFile,
    priorInFlightAgents: sameSession ? prior.inFlightAgents : [],
    spawn: step.spawn,
  });
  journal.save(state);

  const tracker = new BudgetTracker((config && config.budgets) || {});
  if (step.budgetText) tracker.estimateFromChars(step.budgetText, true);
  return tracker.evaluateLimits();
}

module.exports = { FILE_TOOL_KEYS, SPAWN_TOOL_NAMES, firstString, extractSpawn, parseToolPayload, recordStep };
