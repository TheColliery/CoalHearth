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
  //
  // The heading line matches `(?=\s*(?:[^\w\s]|$)).*$` after the keyword, not `\s*$`
  // right after it (2026-07-31 audit, HIGH): a bare `\s*$` required the keyword to be
  // the ENTIRE heading, so any suffix -- "## Working Rules (every session)",
  // "## Constraints -- v2" -- broke the `$` anchor and silently dropped the whole
  // section.
  //
  // A plain `\b` (station-3 findings-back, M2, 2026-07-31) is not enough: `text.match`
  // is non-global, so the FIRST satisfying heading wins, and `\b` alone accepts a
  // decoy heading that just happens to start with the keyword and continue as an
  // ordinary phrase -- "## Constraints notes about foo" -- silently shadowing a real
  // "## Constraints" section further down (wrong content, no error; worse than the
  // suffix bug, which at least produced an empty, visibly-suspicious `[]`). The
  // lookahead requires whatever follows the keyword (after optional whitespace) to be
  // either end-of-line or a NON-word, NON-whitespace character -- punctuation like
  // `(`, `-`, `:`, an em dash -- so "(every session)" and "-- v2" still open a section
  // (their first non-space character is punctuation) while "notes about foo" does not
  // (its first non-space character is a letter, i.e. a genuine second word). This also
  // subsumes what a trailing `\b` would have guarded (M1): "## Constraintsy stuff"
  // fails the same lookahead, because the character right after "Constraints" is the
  // word character "y", neither end-of-line nor non-word/non-whitespace.
  //
  // Deliberately still NOT matched, so a suffix is "tolerated", not "any suffix
  // accepted" -- record kept honest rather than restated as fully solved. Two
  // families still silently drop: a suffix that continues directly as a WORD
  // CHARACTER with no separator ("## Constraints_v2", "## Working Rules2026") or a
  // double space the literal alternation doesn't special-case ("## Working  Rules");
  // and the whole "keyword + space + plain word" family the lookahead exists to
  // reject -- "## Constraints v2", "## Constraints 2026", "## Constraints and
  // Guardrails", "## Working Rules for contributors" all drop too, because a version
  // tag or topic phrase written as a separate word is, to this regex, indistinguishable
  // from the decoy shape it was built to refuse (station-3 M2). Pre-existing in the
  // first family, a deliberate trade in the second -- not a regression either way: the
  // accept-set here is a strict SUPERSET of what the pre-2026-07-31 `\s*$` anchor ever
  // matched (verified across 28 heading shapes), so every one of these was ALREADY
  // dropping before this fix; nothing that used to work now doesn't. And the failure
  // is paid in the SAFE direction -- `[]` (visibly empty, not silently wrong) -- which
  // is the whole point of narrowing the OPENER instead of ranking matches: an opener
  // that only widens the accept-set can misfire toward wrong content (M2's decoy);
  // narrowing it can only misfire toward empty.
  //
  // ASCII-only residual (non-blocking, watch on THIS project specifically -- its own
  // governance is bilingual TH/EN): `\w` has no `u` flag, so a non-ASCII second word
  // PASSES where an ASCII one drops -- "## Working Rules ทุกเซสชัน" matches, "##
  // Working Rules for agents" does not. Errs toward matching, so a non-ASCII decoy
  // heading could in principle still shadow a real section the way M2's ASCII decoy
  // did before this fix. Narrow enough not to fix here.
  //
  // ponytail: parseTaskMd (this file, :21-49) line-scans with no ^/$ semantics and
  // nothing to anchor wrong -- porting parseConstraints to that shape removes the
  // anchor-bug surface by construction. Next unit, not this one.
  const section = text.match(/^##\s*(Constraints|Working Rules)(?=\s*(?:[^\w\s]|$)).*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
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
 * @param {{sessionId?: string, transcriptPath?: string, priorModifiedFiles?: string[],
 *          touchedFile?: string, priorInFlightAgents?: Array, spawn?: Object}} [opts]
 *   sessionId = the hook payload's session id — WHO owns this journal (H3 identity: the
 *     resume block prints it, recordStep matches it so a second session in the same
 *     workspace can't clobber this one, CoalWash's estate guard protects that session's
 *     transcript). Absent -> the field is omitted (JSON drops undefined), old behavior;
 *   transcriptPath = the hook payload's transcript_path — the aborted session's CC transcript,
 *     stat'd by the resume block to detect a GC'd transcript (a dead `--resume`). Omitted absent;
 *   priorModifiedFiles = the previous journal's accumulated list (same session);
 *   touchedFile = the file path the CURRENT tool call modified, if any;
 *   priorInFlightAgents = the previous journal's accumulated spawn records;
 *   spawn = an in-flight-subagent record if THIS tool call was an Agent/Task spawn.
 * @returns {{sessionId?:string, transcriptPath?:string, status:string, checklist:Array,
 *            modifiedFiles:string[], inFlightAgents:Array, activePlan:Object}}
 */
function buildStateSnapshot(cwd = process.cwd(), opts = {}) {
  const { goal, checklist, nextSteps } = parseTaskMd(cwd);
  return {
    sessionId: typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : undefined,
    // The aborted session's CC transcript path — stat'd by the resume block to catch a
    // transcript CC has since garbage-collected. Omitted when absent (JSON drops undefined),
    // exactly like sessionId; a rare payload without it just means no GC check that step.
    transcriptPath: typeof opts.transcriptPath === 'string' && opts.transcriptPath ? opts.transcriptPath : undefined,
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
