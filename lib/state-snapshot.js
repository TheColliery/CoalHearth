// CoalHearth state-snapshot builder — reads the local workspace (task.md, AGENTS.md,
// git) to construct the HandoffJournal state, replacing the BLUEPRINT §4B stub
// helpers with real (best-effort) parsers. Zero-dep (fs/path/child_process built-ins
// only), fail-silent per hooks-safety.md: every reader degrades to an empty default
// rather than throwing — a missing task.md / no git / a non-git workspace are all
// normal, not errors (no-external-assumption: git is an OPTIONAL enhancement).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
  const section = text.match(/^##\s*(Constraints|Working Rules)\s*$([\s\S]*?)(?=^##\s|\Z)/im);
  if (!section) return [];
  return section[2]
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*[-*]\s+(.+)$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

// git is an OPTIONAL enhancement (no-external-assumption): a non-git workspace or a
// missing git binary degrades to an empty list, never a thrown error.
function getModifiedFiles(dir) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], // suppress git's stderr (e.g. "not a git repository") -- fail-silent
    });
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Builds the HandoffJournal state snapshot from the local workspace.
 * @param {string} [cwd] workspace root to read from (default process.cwd()).
 * @returns {{status:string, checklist:Array, modifiedFiles:string[], activePlan:Object}}
 */
function buildStateSnapshot(cwd = process.cwd()) {
  const { goal, checklist, nextSteps } = parseTaskMd(cwd);
  return {
    status: 'in_progress',
    checklist,
    modifiedFiles: getModifiedFiles(cwd),
    activePlan: {
      goal,
      nextSteps,
      constraints: parseConstraints(cwd),
    },
  };
}

module.exports = { buildStateSnapshot };
