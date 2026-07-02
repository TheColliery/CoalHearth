// CoalHearth journal-dir containment — the ONE resolver every outputDirectory
// consumer routes through (HandoffJournal writes/prunes, ResumeEngine reads/
// quarantine/mark-resumed). `journal.outputDirectory` is merged from the UNTRUSTED
// project `.coalhearth.json`, so a cloned repo shipping
// {"journal":{"outputDirectory":"../../victim"}} must never aim CoalHearth's
// writes or prunes outside the workspace (audit 2026-07-02 MED — reproduced:
// save() wrote and _pruneOldLogs deleted in an arbitrary outside dir).
//
// Discipline: realpath-and-contain BOTH sides (hooks-safety lesson — lexical
// containment defeats `..` but NOT a symlink escape; root is realpathed too or a
// symlinked tmp/home no-ops legit work), fail-closed on unresolvable. An escaping
// or unresolvable configured dir CLAMPS to the default owned dir; if even that
// cannot be physically contained, returns null and callers no-op (fail-closed,
// fail-silent — never a throw, per Phoenix-13).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.join('.claude', 'coalhearth');

/**
 * Resolve a (possibly untrusted) configured output directory, contained under root.
 * @param {string} [configured] the config-supplied journal.outputDirectory
 * @param {string} [root] the workspace root to contain under (default process.cwd())
 * @returns {string|null} an absolute dir physically inside root, or null (fail-closed)
 */
function containedOutputDir(configured, root = process.cwd()) {
  const rootAbs = path.resolve(root);
  const wanted = typeof configured === 'string' && configured ? [configured, DEFAULT_OUTPUT_DIR] : [DEFAULT_OUTPUT_DIR];
  for (const dir of wanted) {
    const candidate = path.resolve(rootAbs, dir);
    // Lexical pre-check: reject `..` / absolute escapes BEFORE creating anything.
    const lex = path.relative(rootAbs, candidate);
    if (lex.startsWith('..') || path.isAbsolute(lex)) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch (_) {
      // may already exist / be blocked by a file — the realpath check below decides
    }
    // Physical check: a lexically-inside dir symlinked outside still LOOKS contained.
    let rel;
    try {
      rel = path.relative(fs.realpathSync(rootAbs), fs.realpathSync(candidate));
    } catch (_) {
      continue; // unresolvable -> fail-closed, fall through to the default / null
    }
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return candidate;
  }
  return null;
}

module.exports = { containedOutputDir, DEFAULT_OUTPUT_DIR };
