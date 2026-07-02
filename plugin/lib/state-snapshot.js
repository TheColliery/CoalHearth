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

/**
 * Builds the HandoffJournal state snapshot from the local workspace.
 * @param {string} [cwd] workspace root to read from (default process.cwd()).
 * @param {{priorModifiedFiles?: string[], touchedFile?: string}} [opts]
 *   priorModifiedFiles = the previous journal's accumulated list (same session);
 *   touchedFile = the file path the CURRENT tool call modified, if any.
 * @returns {{status:string, checklist:Array, modifiedFiles:string[], activePlan:Object}}
 */
function buildStateSnapshot(cwd = process.cwd(), opts = {}) {
  const { goal, checklist, nextSteps } = parseTaskMd(cwd);
  return {
    status: 'in_progress',
    checklist,
    modifiedFiles: mergeModifiedFiles(cwd, opts.priorModifiedFiles, opts.touchedFile),
    activePlan: {
      goal,
      nextSteps,
      constraints: parseConstraints(cwd),
    },
  };
}

module.exports = { buildStateSnapshot };
