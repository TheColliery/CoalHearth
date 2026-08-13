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

// Board #94 (issue #13): the single highest-value gap named by the operator was "no
// per-subagent progress record" — when a spawn resolves (this hook fires exactly once
// per Agent/Task/Workflow call, AT resolution, success or failure), extractSpawn used
// to discard tool_response entirely except for a residue path. deriveStatus/deriveOutcome
// capture what it actually says, so a revive-vs-defer decision has something to price.
//
// deriveStatus is deliberately NOT trusted as ground truth downstream (resume-engine's
// prompt always says "verify liveness, do not assume from status alone") — the reported
// incident's own second subagent said `status: failed` and had actually completed. So an
// UNRECOGNIZED or ABSENT status reads 'unknown', never silently 'completed': assuming
// success from silence would be the same misplaced trust in the other direction.
const STATUS_VOCAB = [
  [/fail|error|terminat/i, 'failed'],
  [/complet|success|\bok\b|done/i, 'completed'],
];
function deriveStatus(resp) {
  const s = typeof resp.status === 'string' ? resp.status : '';
  if (!s) return 'unknown';
  for (const [re, label] of STATUS_VOCAB) if (re.test(s)) return label;
  return 'unknown';
}

// A short, size-capped best-effort snippet of WHAT the subagent reported — the "7 of 11
// checks done" or "Now the search_path convention check" line the issue names as the
// input the revive-or-defer decision actually needs. Probed across plausible fields
// (the tool_response shape is undocumented, same probe-not-require discipline as
// outputPath below); capped so one huge tool_response can't bloat the journal.
const OUTCOME_CAP = 300;
function deriveOutcome(resp) {
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  const raw = str(resp.error) || str(resp.summary) || str(resp.message) || str(resp.result) || str(resp.output) || str(resp.text);
  if (!raw) return undefined;
  return raw.length > OUTCOME_CAP ? `${raw.slice(0, OUTCOME_CAP)}…` : raw;
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
    // This hook fires exactly once per spawn call, AT RESOLUTION (Claude Code's
    // PostToolUse contract) -- so `spawnedAt` names WHEN THIS HOOK OBSERVED THE CALL,
    // which for a spawn tool is resolution time, not dispatch time. Kept as-is (many
    // tests + the field's existing consumers key on this name) rather than renamed for
    // cosmetic accuracy -- board #94 adds status/outcome alongside it instead.
    spawnedAt: new Date().toISOString(),
    status: deriveStatus(resp),
    outcome: deriveOutcome(resp),
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
 * Record one journal step: accumulate session state onto the prior save and persist it
 * atomically under a lock. Never throws (fail-silent). Returns nothing — the recovery core
 * is the whole job (the advisory budget guardrail was retired: see CHANGELOG — a fresh
 * per-call BudgetTracker never accumulated, so shouldBlockSpawning needed a single >6.8 MB
 * payload to fire at the 2M default and was structurally unreachable).
 * @param {string} cwd the caller's process.cwd() — the SNAPSHOT read base only (task.md /
 *   AGENTS.md lookup + the lexical modifiedFiles relativization). It is deliberately NOT
 *   the journal root: HandoffJournal is constructed with no root, so the journal
 *   auto-anchors to the resolved project root instead (hooks-safety.md §8).
 * @param {Object} config loaded .coalhearth.json ({journal}).
 * @param {{sessionId?: string, transcriptPath?: string, touchedFile?: string, spawn?: Object}} step
 */
function recordStep(cwd, config, step) {
  const journal = new HandoffJournal((config && config.journal) || {});
  const myId = typeof step.sessionId === 'string' && step.sessionId ? step.sessionId : undefined;
  // The WHOLE load→merge→save runs under one lock (H1): N concurrent PostToolUse hooks
  // can no longer read-then-clobber each other's accumulated lists. mergeFn decides what to
  // accumulate onto; the lock guarantees the prior it sees is the one it overwrites.
  journal.updateUnderLock((prior) => {
    // "Same session" = accumulate onto this prior, else start the lists fresh. Prefer
    // IDENTITY (H3): a prior written by THIS session id is mine regardless of status — so a
    // second session booting in the same workspace (which flips the shared journal to
    // 'resumed') no longer makes my next step discard my own accumulated files. When either
    // id is unknown (a payload without one, an old journal), fall back to the status proxy —
    // the pre-existing behavior + the mark-resumed contamination guard still hold.
    const priorId = prior && typeof prior.sessionId === 'string' && prior.sessionId ? prior.sessionId : undefined;
    const sameSession = (myId && priorId)
      ? priorId === myId
      : !!(prior && prior.status === 'in_progress');
    return buildStateSnapshot(cwd, {
      sessionId: myId,
      transcriptPath: step.transcriptPath, // stat'd on resume to detect a GC'd transcript
      priorModifiedFiles: sameSession ? prior.modifiedFiles : [],
      touchedFile: step.touchedFile,
      priorInFlightAgents: sameSession ? prior.inFlightAgents : [],
      spawn: step.spawn,
    });
  });
}

module.exports = { FILE_TOOL_KEYS, SPAWN_TOOL_NAMES, firstString, deriveStatus, deriveOutcome, extractSpawn, parseToolPayload, recordStep };
