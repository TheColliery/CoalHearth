// CoalHearth state-snapshot builder — reads the local workspace (task.md, AGENTS.md)
// plus what the PostToolUse hook itself observed to construct the HandoffJournal
// state, replacing the BLUEPRINT §4B stub helpers with real (best-effort) parsers.
// Zero-dep (fs/path built-ins only), fail-silent per hooks-safety.md: every reader
// degrades to an empty default rather than throwing — a missing task.md is normal,
// not an error. NO child processes (Phoenix #5 — the earlier best-effort
// `git status` spawn violated it AND cost a spawn per tool call on big repos;
// audit 2026-07-02 MED): modifiedFiles now accumulates from the file paths the
// hook SEES in tool calls — a more accurate "what changed this session" than
// git status (which also lists pre-session dirt), and free.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECKLIST_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/;

// task.md convention: first `# ` or `## Goal` heading = the goal; a checklist of
// `- [ ] task` / `- [x] task` lines = the checklist; unchecked items double as
// nextSteps (the plan not yet done).
function parseTaskMd(dir) {
  const empty = { goal: '', checklist: [], nextSteps: [] };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'task.md'), 'utf8');
  } catch {
    return empty; // no task.md -> nothing to report, not an error
  }

  const lines = text.split(/\r?\n/);
  let goal = '';
  const checklist = [];
  const nextSteps = [];
  for (const line of lines) {
    const box = line.match(CHECKLIST_RE);
    if (box) {
      const done = box[1].toLowerCase() === 'x';
      const task = box[2].trim();
      checklist.push({ task, status: done ? 'done' : 'todo' });
      if (!done) nextSteps.push(task);
      continue;
    }
    if (!goal) {
      const heading = line.match(/^#{1,2}\s+(.+)$/);
      if (heading) goal = heading[1].trim();
    }
  }
  return { goal, checklist, nextSteps };
}

// AGENTS.md convention: a "## Constraints" or "## Working Rules" section's bullet
// lines. Best-effort — absent section/file -> empty list, never a hard requirement.
function parseConstraints(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  } catch {
    return [];
  }
  // Stop at the next `## ` heading OR true end-of-input. Use `(?![\s\S])` for
  // end-of-input, NOT `\Z` — JS regex has no `\Z` anchor, it matches a literal "Z",
  // so when Constraints is the LAST section the lazy body finds no stop point and
  // the whole match silently fails -> constraints dropped, resumed agent loses its
  // guardrails (audit 2026-07-02 HIGH).
  const section = text.match(/^##\s*(Constraints|Working Rules)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
  if (!section) return [];
  return section[2]
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

// Accumulate "what changed this session" from what the hook observes: the prior
// journal's list + the file the current tool call touched. Pure lexical merge —
// no spawn, no git (Phoenix #5), no realpath on the hot path. Paths are stored
// relative to cwd when inside it (readable in the recovery block), absolute
// otherwise. Deduped, order-preserving. (A symlinked workspace where cwd and the
// payload path disagree on the /private prefix is a rare cosmetic case — the
// file is still captured, just absolute; not worth a hot-path realpath. The
// hermetic tests realpath their own tmpdir sandbox so the macOS /private-symlink
// artifact doesn't make an equality assertion flap.)
function mergeModifiedFiles(cwd, priorFiles, touchedFile) {
  const files = Array.isArray(priorFiles) ? priorFiles.filter((f) => typeof f === 'string' && f) : [];
  if (typeof touchedFile === 'string' && touchedFile) {
    const rel = path.relative(cwd, path.resolve(cwd, touchedFile));
    const entry = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : touchedFile;
    if (!files.includes(entry)) files.push(entry);
  }
  return files;
}

// Accumulate in-flight subagent spawns (Incident E, MEMORY.md Field Evidence): the
// PostToolUse hook sees every Agent/Task spawn call, so recording each lets a resume
// LIST which subs were running at interruption + where their residue lives. HONEST
// SCOPE: this does NOT recover a dead sub's WORK (that would need the sub itself to
// journal, which the parent can't force) — it RECORDS the sub existed, so main/human
// can re-spawn or reconstruct. Prior list + at most this call's one spawn, deduped
// on the full record (a re-run never re-adds the same spawn — the hook fires once
// per tool call — but the guard is cheap and defensive). Order-preserving.
function mergeInFlightAgents(priorAgents, spawn) {
  const agents = Array.isArray(priorAgents)
    ? priorAgents.filter((a) => a && typeof a === 'object' && !Array.isArray(a))
    : [];
  if (spawn && typeof spawn === 'object') {
    const dup = agents.some(
      (a) =>
        a.description === spawn.description &&
        a.subagentType === spawn.subagentType &&
        a.outputPath === spawn.outputPath &&
        a.spawnedAt === spawn.spawnedAt
    );
    if (!dup) agents.push(spawn);
  }
  return agents;
}

/**
 * Builds the HandoffJournal state snapshot from the local workspace.
 * @param {string} [cwd] workspace root to read from (default process.cwd()).
 * @param {{sessionId?: string, priorModifiedFiles?: string[], touchedFile?: string,
 *          priorInFlightAgents?: Array, spawn?: Object}} [opts]
 *   sessionId = the hook payload's session id — WHO owns this journal (H3 identity: the
 *     resume block prints it, recordStep matches it so a second session in the same
 *     workspace can't clobber this one, CoalWash's estate guard protects that session's
 *     transcript). Absent -> the field is omitted (JSON drops undefined), old behavior;
 *   priorModifiedFiles = the previous journal's accumulated list (same session);
 *   touchedFile = the file path the CURRENT tool call modified, if any;
 *   priorInFlightAgents = the previous journal's accumulated spawn records;
 *   spawn = an in-flight-subagent record if THIS tool call was an Agent/Task spawn.
 * @returns {{sessionId?:string, status:string, checklist:Array, modifiedFiles:string[],
 *            inFlightAgents:Array, activePlan:Object}}
 */
function buildStateSnapshot(cwd = process.cwd(), opts = {}) {
  const { goal, checklist, nextSteps } = parseTaskMd(cwd);
  return {
    sessionId: typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : undefined,
    status: 'in_progress',
    checklist,
    modifiedFiles: mergeModifiedFiles(cwd, opts.priorModifiedFiles, opts.touchedFile),
    inFlightAgents: mergeInFlightAgents(opts.priorInFlightAgents, opts.spawn),
    activePlan: {
      goal,
      nextSteps,
      constraints: parseConstraints(cwd),
    },
  };
}

module.exports = { buildStateSnapshot };
