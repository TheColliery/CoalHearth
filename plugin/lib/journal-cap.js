// CoalHearth journal size cap (R14 FIXBACK, INSPECT MEDIUM-1). The WRITER must be unable to produce a journal its own READER refuses.
//
// WHY: CWK-137 bounded every read of the journal at MAX_JOURNAL_BYTES (lib/repo-fs.js), and an over-bound journal reads as absent.
// But `modifiedFiles` accumulates for the whole session (lib/state-snapshot.js), so a long session (a codemod, a monorepo-wide
// rename: about 78,000 distinct paths) could write a journal past that bound, and the NEXT hook step found prior === null, started
// a fresh state and renamed it over the old journal: the goal, the checklist and every path gone, silently, and the session no
// longer resumable. fitJournal() is called by HandoffJournal.save(), the one place every hook-side journal write is serialised.
//
// THE DERIVATION (every number below comes from the reader's bound, none is a guess):
//   MAX_JOURNAL_BYTES            4,194,304  what the reader accepts (st.size > bound = refused, never truncated)
//   JOURNAL_MARGIN_BYTES            65,536  = MAX/64. Held back from the writer's budget for what is written AFTER save() shapes the
//                                           payload: ResumeEngine.markResumed re-serialises the journal with a changed `status`
//                                           (a word that is never longer than 'in_progress') and SessionStart may add the small
//                                           `_orphanSweep` object (well under 1 KiB); the margin is ~60x that worst case.
//   JOURNAL_BUDGET_BYTES         4,128,768  = MAX - margin. A journal fitJournal() returns is at or under this, strictly under MAX.
//   JOURNAL_TRIM_HEADROOM_BYTES    262,144  = 256 KiB. When a trim is needed it trims to (budget - headroom), not to the budget, so the
//                                           following steps (each adds ~100 B) do not re-trim on every PostToolUse: a hot path
//                                           that re-serialised a 4 MB journal on every call would break Phoenix #3. ~2,500 steps
//                                           of room per trim, and a trim itself is two serialisations (measured, one trim of a
//                                           78,000-path journal is well under a second, once per ~2,500 steps).
//
// WHAT IT DOES, in order, and only when the payload exceeds the budget:
//   1. drops the OLDEST `modifiedFiles` entries until the payload fits (the most recent paths are what a resume needs);
//   2. if every path is gone and it is still over, drops the OLDEST `inFlightAgents` records the same way;
//   3. records each drop as a count (`modifiedFilesDropped`, `inFlightAgentsDropped`, cumulative across trims) so the recovery block
//      can say "N earlier path(s) not listed": a truncation is never silent.
// THE RESIDUAL, named: the FIXED fields (`goal`, `checklist`, `activePlan`, parsed from task.md and AGENTS.md, each up to 4 MiB
// themselves) are never truncated here: a truncated goal or checklist would resume the wrong plan. If they alone exceed the budget
// fitJournal() returns null, save() returns false, and the LAST GOOD journal stays on disk untouched (it is under the bound, so it
// still reads and resumes). The journal then stops advancing until task.md/AGENTS.md shrink; nothing is lost and nothing is
// quarantined. The reader's refusal stays the backstop for any journal this writer did not produce (a hand-edited or foreign one).
'use strict';

const { MAX_JOURNAL_BYTES } = require('./repo-fs.js');

const JOURNAL_MARGIN_BYTES = 64 * 1024;
const JOURNAL_BUDGET_BYTES = MAX_JOURNAL_BYTES - JOURNAL_MARGIN_BYTES;
const JOURNAL_TRIM_HEADROOM_BYTES = 256 * 1024;
const MAX_TRIM_PASSES = 6; // the per-entry estimate is close, so one or two passes fit; the cap only bounds a pathological shape

const bytes = (s) => Buffer.byteLength(s, 'utf8');

// What HandoffJournal.save() has always written: a timestamp, then the state, pretty-printed.
function render(state) {
  return JSON.stringify({ timestamp: new Date().toISOString(), ...state }, null, 2);
}

// Bytes one array entry costs in the pretty form: its own pretty text, re-indented under the array (4 spaces a line), plus the
// comma and the newline. An estimate by construction; the exact size is always re-measured after a drop.
function entryCost(entry) {
  return bytes(JSON.stringify(entry, null, 2).replace(/\n/g, '\n    ')) + 6;
}

// Drop the oldest entries of state[key] until about `want` bytes are freed; returns the new state (never mutates the input).
function dropOldest(state, key, want) {
  const list = state[key];
  let n = 0;
  let freed = 0;
  while (n < list.length && freed < want) freed += entryCost(list[n++]);
  if (n === 0) return state;
  const dropKey = key + 'Dropped';
  const before = Number.isFinite(state[dropKey]) && state[dropKey] > 0 ? Math.floor(state[dropKey]) : 0;
  return { ...state, [key]: list.slice(n), [dropKey]: before + n };
}

/**
 * Serialise `state` as the journal, within `budget` bytes, dropping the oldest accumulated entries if it must.
 * @param {Object} state the journal state (the shape recordStep builds).
 * @param {number} [budget] the largest serialised size accepted (default JOURNAL_BUDGET_BYTES).
 * @param {number} [headroom] how far below the budget a needed trim lands (default JOURNAL_TRIM_HEADROOM_BYTES).
 * @returns {string|null} the journal text, at or under `budget` bytes; null when even the fixed fields do not fit.
 */
function fitJournal(state, budget = JOURNAL_BUDGET_BYTES, headroom = JOURNAL_TRIM_HEADROOM_BYTES) {
  let payload = render(state);
  if (bytes(payload) <= budget) return payload;
  const target = Math.max(0, budget - headroom);
  let cur = state;
  for (const key of ['modifiedFiles', 'inFlightAgents']) {
    for (let pass = 0; pass < MAX_TRIM_PASSES && Array.isArray(cur[key]) && cur[key].length > 0 && bytes(payload) > target; pass++) {
      cur = dropOldest(cur, key, bytes(payload) - target);
      payload = render(cur);
    }
  }
  return bytes(payload) <= budget ? payload : null;
}

module.exports = { JOURNAL_MARGIN_BYTES, JOURNAL_BUDGET_BYTES, JOURNAL_TRIM_HEADROOM_BYTES, fitJournal };
