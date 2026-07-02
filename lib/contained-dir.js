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
    // Physical check BEFORE mkdir (audit 2026-07-02 L3): a lexically-inside dir
    // symlinked outside still LOOKS contained. Verify the RESOLVED path is inside
    // root *before* creating anything, so an escaping candidate never leaks an
    // empty dir outside root (the old order mkdir'd first, then returned null —
    // fail-closed on the return but the incidental dir already existed outside).
    // The candidate itself may not exist yet (a legit first-run dir), so resolve
    // the nearest EXISTING ancestor's realpath and re-append the un-created tail;
    // any symlink in the existing part is thereby followed, an unresolvable root
    // fails closed.
    let realCandidate;
    try {
      realCandidate = resolveThroughExisting(candidate);
    } catch (_) {
      continue; // unresolvable -> fail-closed, fall through to the default / null
    }
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootAbs);
    } catch (_) {
      continue; // root has no physical path -> fail-closed
    }
    const rel = path.relative(realRoot, realCandidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // escapes -> skip
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch (_) {
      continue; // blocked by a file / perms -> fall through to default / null
    }
    return candidate;
  }
  return null;
}

// Realpath the deepest ANCESTOR of `p` that exists on disk, then re-join the
// not-yet-created tail — so a symlink anywhere in the existing prefix is resolved
// (catching a symlink escape) while a brand-new leaf dir still resolves. Throws
// only if not even the filesystem root resolves (fail-closed at the call site).
function resolveThroughExisting(p) {
  const parts = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...parts.reverse());
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error('unresolvable'); // hit the root, none existed
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
}

module.exports = { containedOutputDir, DEFAULT_OUTPUT_DIR };
