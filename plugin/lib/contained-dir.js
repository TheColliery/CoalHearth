// CoalHearth journal-dir containment — the ONE resolver every outputDirectory
// consumer routes through (HandoffJournal writes/prunes, ResumeEngine reads/
// quarantine/mark-resumed). `journal.outputDirectory` is merged from the UNTRUSTED
// project `.coalhearth.json`, so a cloned repo shipping
// {"journal":{"outputDirectory":"../../victim"}} must never aim CoalHearth's
// writes or prunes outside the workspace (audit 2026-07-02 MED — reproduced:
// save() wrote and _pruneOldLogs deleted in an arbitrary outside dir).
//
// Discipline: realpath-and-contain BOTH sides (node/runtime.md §4 — realpathSync
// .native, not plain, and FAIL CLOSED on an unresolvable path, never a lexical
// fallback). An escaping or unresolvable configured dir CLAMPS to the default owned
// dir; if even that cannot be physically contained, returns null and callers no-op
// (fail-closed, fail-silent — never a throw, per Phoenix-13).
//
// Phantom-slug law (hooks-safety.md §8, USER 2026-07-25): a caller that omits `root`
// must NEVER get raw process.cwd() as the anchor — a subagent whose cwd sits in a
// project SUBDIR (CoalWash/scripts/lib, .claude/rules/ecc/common, ...) would then
// plant its own `.claude/coalhearth/`, one per visited subdir (26 phantoms measured
// live 2026-07-25, 25 sharing one sessionId, none at a real project root). So the
// DEFAULT itself walks up to the nearest real project marker (`.git` or the user's own
// `.coalhearth.json` — the SAME two markers load-config.js treats as "this is a
// project") and, finding none by the time it reaches home, returns null: no directory
// is ever manufactured to prove a project that isn't there. A caller that passes an
// EXPLICIT root (every current test) is untouched — the auto-anchor only fires when
// root is omitted.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.join('.claude', 'coalhearth');

// realpath to the PHYSICAL path via the expanding, 8.3/case-correct variant
// (node/runtime.md §4). Fails CLOSED (null) on an unresolvable path — never a lexical
// path.resolve fallback (unlike load-config.js's `physical()`, whose fail-OPEN-to-cwd
// contract is correct for a config READ but wrong for this fail-closed anchor).
function physicalOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (_) {
    return null;
  }
}

function isProjectMarked(dir) {
  return fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.coalhearth.json'));
}

// Walk up from `startDir` to the nearest ancestor carrying a project marker, NEVER
// past `home` (load-config.js's existing hermetic-test-isolation stop condition).
// Returns the physical project root, or null when no marker exists between startDir
// and home inclusive, or either endpoint is unresolvable — an unanchored cwd resolves
// to "no project", never to itself.
function findWorkspaceRoot(startDir, home = os.homedir()) {
  let dir = physicalOrNull(startDir);
  const homeAbs = physicalOrNull(home);
  if (!dir || !homeAbs) return null;
  for (;;) {
    if (isProjectMarked(dir)) return dir;
    if (dir === homeAbs) return null; // reached home, no marker found -> no real project
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root reached, none found
    dir = parent;
  }
}

// Legacy-phantom self-clean (hooks-safety.md §8, "self-clean its own stray state on
// write"). Fires ONLY from the auto-anchored path, and only when raw cwd differs from
// the resolved root — exactly the shape the pre-fix code could have planted a phantom
// in. Scoped to DEFAULT_OUTPUT_DIR only (every observed phantom is there; a custom
// `outputDirectory` legacy phantom is not chased — the prevention half above already
// covers that case going forward, this is only the mop-up for the default shape).
// Removes ONLY this tool's own known filenames (the `session_handoff` family); rmdir
// is a no-op-fails (ENOTEMPTY) if anything foreign remains, so a directory holding a
// foreign file is never forced empty. Best-effort, fail-silent (Phoenix-13).
function selfCleanLegacyPhantom(rawCwdAbs, anchoredRootAbs) {
  if (rawCwdAbs === anchoredRootAbs) return; // no drift -> the "legacy" dir IS the one we just used
  const legacyDir = path.resolve(rawCwdAbs, DEFAULT_OUTPUT_DIR);
  try {
    for (const name of fs.readdirSync(legacyDir)) {
      if (!name.startsWith('session_handoff')) continue; // never a foreign file
      try { fs.unlinkSync(path.join(legacyDir, name)); } catch (_) {}
    }
    fs.rmdirSync(legacyDir); // fails harmlessly (ENOTEMPTY) if a foreign file remains
  } catch (_) {
    // absent / not a dir / permission -> nothing to clean, non-fatal
  }
}

/**
 * Resolve a (possibly untrusted) configured output directory, contained under root.
 * @param {string} [configured] the config-supplied journal.outputDirectory
 * @param {string} [root] the workspace root to contain under. Omitted (the default) ->
 *   auto-anchored to the resolved project root (hooks-safety.md §8), never raw cwd.
 * @returns {string|null} an absolute dir physically inside root, or null (fail-closed:
 *   an escaping/unresolvable configured dir, OR no real project root found)
 */
function containedOutputDir(configured, root) {
  const autoAnchored = root === undefined;
  if (autoAnchored) {
    root = findWorkspaceRoot(process.cwd());
    if (!root) return null; // no real project boundary -> fail-closed, never a phantom
  }
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
      realRoot = fs.realpathSync.native(rootAbs);
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
    if (autoAnchored) selfCleanLegacyPhantom(process.cwd(), rootAbs);
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
      return path.join(fs.realpathSync.native(cur), ...parts.reverse());
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error('unresolvable'); // hit the root, none existed
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Exported so a caller that wants to WARN on a blocked/escaping outputDir can first
// check whether a real project exists at all — "no project here" (a stray cwd, or a
// tool call that drifted into a subdir with nothing above it) is silent-and-expected,
// never the same "may repeat" class of problem as "a real project's journal dir is
// blocked by a file". See bin/session-start.js and bin/ag-pre-invocation.js.
module.exports = { containedOutputDir, findWorkspaceRoot, DEFAULT_OUTPUT_DIR };
