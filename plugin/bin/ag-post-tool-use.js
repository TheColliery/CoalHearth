#!/usr/bin/env node
// CoalHearth post-tool journal hook — the ONE entry for every non-Claude-Code hook
// platform (Antigravity + the 5 config-only platforms). Claude Code keeps bin/post-tool-use.js.
// The journal step is IDENTICAL on every platform, so the argv mode the templates pass
// (AfterTool / FileCopy / PostToolUse) is accepted but no longer branches anything here —
// the only per-mode difference used to be the advisory budget-nudge channel, and that
// guardrail was retired (structurally unreachable; see CHANGELOG). bin/ag-pre-invocation.js
// still uses the argv modes (its resume-emit channel genuinely differs per platform).
//
// Phoenix-13 identical to the CC adapter: fail-silent, zero-dep, no network, no child
// process, no process.exit(). This hook now emits NOTHING (journal-only).
//
// The ONLY platform-specific work here is normalizing the payload shape into the
// Claude-Code shape lib/journal-step.js parses (one-flock: the parse/save logic is the
// SHARED core, not re-implemented). Written DEFENSIVELY per the pilot's honest scope: no
// platform's full post-tool payload shape was captured, so every field is read tolerantly
// (snake_case core fields, camelCase `toolCall.*`/`toolInput`) and an unknown tool name
// degrades to a no-op contribution (never crash) — the session state still journals; only
// that one tool's touched-file/spawn is skipped.
//
// NOT validated live on any of these platforms (tier: wired) — hence the defensive
// reader. No claim here is "validated on <platform>".
'use strict';

const {
  FILE_TOOL_KEYS,
  SPAWN_TOOL_NAMES,
  firstString,
  parseToolPayload,
  recordStep,
} = require('../lib/journal-step.js');

// File-editing tool names -> normalized to CC 'Write' (its path arg becomes file_path).
// AG: `write_to_file` is the one the pilot doc names; the other AG entries are plausible
// family candidates, UNVERIFIED — safe because an unmapped tool degrades to a no-op
// (below). Gemini CLI: `write_file` + `replace` ARE its two file tools (primary docs,
// verified 2026-07-15 — the same pair CoalMine's Gemini config matches on).
const AG_FILE_TOOLS = new Set([
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'create_file',
  'apply_diff',
  'multiedit',
  'write_file', // Gemini CLI
  'replace',    // Gemini CLI (its edit tool; args carry file_path)
]);
// Plausible path-arg keys inside an AG file-tool's args — probed in order (the exact
// key is unverified; missing all of them -> no path recorded, still no crash).
const AG_PATH_KEYS = ['file_path', 'path', 'TargetFile', 'target_file', 'filePath', 'notebook_path', 'AbsolutePath'];
// AG subagent-spawn tool candidates (UNVERIFIED — AG's spawn schema was not captured).
// CC-vocab spawn names (Agent/Task/Workflow) are handled by the pass-through below, so
// this set holds only AG-native guesses; wrong guesses degrade to a no-op.
const AG_SPAWN_TOOLS = new Set(['spawn_subagent', 'run_subagent', 'subagent', 'dispatch_agent']);

const pickObject = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : undefined;

// Normalize an AG PostToolUse payload into the CC {tool_name, tool_input, tool_response}
// shape. Never throws (returns {} for garbage). See the header for the honest-scope note.
function normalizeAgToolPayload(ag) {
  if (!ag || typeof ag !== 'object') return {};
  const toolCall = pickObject(ag.toolCall) || {};
  const name = firstString(ag, ['tool_name', 'toolName']) || firstString(toolCall, ['name']) || '';
  // camelCase toolInput/toolResponse = the Copilot-CLI-shape probe (its events are
  // camelCase; field casing unverified, so both casings are read — CoalMine parity).
  const args = pickObject(ag.tool_input) || pickObject(ag.toolInput) || pickObject(toolCall.args) || {};
  const resp = pickObject(ag.tool_response) || pickObject(ag.toolResponse) || pickObject(ag.toolResult) || pickObject(toolCall.result) || {};

  // Already CC vocab (a file tool or Agent/Task/Workflow) -> pass through unchanged;
  // the shared parser handles it natively (also the path if AG ever emits CC-shaped names).
  if (FILE_TOOL_KEYS[name] || SPAWN_TOOL_NAMES.has(name)) {
    return { tool_name: name, tool_input: args, tool_response: resp };
  }
  // AG file-writer -> CC 'Write', path probed from the plausible arg keys.
  if (AG_FILE_TOOLS.has(name) || AG_FILE_TOOLS.has(name.toLowerCase())) {
    const filePath = firstString(args, AG_PATH_KEYS);
    return { tool_name: 'Write', tool_input: filePath ? { file_path: filePath } : {}, tool_response: resp };
  }
  // AG spawn candidate -> CC 'Agent', best-effort description/type (Incident E).
  if (AG_SPAWN_TOOLS.has(name) || AG_SPAWN_TOOLS.has(name.toLowerCase())) {
    return {
      tool_name: 'Agent',
      tool_input: {
        description: firstString(args, ['description', 'name', 'task']),
        subagent_type: firstString(args, ['subagent_type', 'subagentType', 'type']),
      },
      tool_response: resp,
    };
  }
  // Unmapped (Read, run_command, unknown) -> a shape the parser treats as a no-op.
  return { tool_name: name || 'Other', tool_input: args, tool_response: resp };
}

try {
  const { loadConfig } = require('../lib/load-config.js');

  let raw = '';
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    // no stdin -- the journal save still runs with no touched file (same as CC adapter)
  }

  let agPayload;
  try {
    agPayload = JSON.parse(raw);
  } catch {
    // not JSON -- nothing to record from the payload
  }

  // payload.cwd = the AUTHORITATIVE workspace; AG's hook spawn cwd is not guaranteed to
  // be it, and the journal MUST land at the workspace. chdir once at entry, BEFORE
  // loadConfig/recordStep — same mechanism + rationale as bin/ag-pre-invocation.js
  // (one-flock with CoalWash's AG adapter). chdir-fail -> keep spawn cwd, best-effort.
  const wsCwd = firstString(agPayload, ['cwd', 'Cwd']);
  if (wsCwd) { try { process.chdir(wsCwd); } catch { /* keep spawn cwd */ } }

  const cfg = loadConfig();

  let parsed = {};
  try {
    parsed = parseToolPayload(normalizeAgToolPayload(agPayload));
  } catch {
    // defensive -- a hostile shape never crashes the hook
  }

  recordStep(process.cwd(), cfg, {
    sessionId: firstString(agPayload, ['session_id', 'sessionId']), // H3: stamp WHO owns this journal
    touchedFile: parsed.touchedFile,
    spawn: parsed.spawn,
  });
} catch {
  // Phoenix #4: fail-silent, never crash the host.
}
