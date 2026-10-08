// CoalHearth journal-dir containment — the ONE resolver every outputDirectory
// consumer routes through (HandoffJournal writes/prunes, ResumeEngine reads/
// quarantine/mark-resumed). `journal.outputDirectory` was merged from the UNTRUSTED
// project `.coalhearth.json` until 2.7.0 (it is global-only now, load-config.js), so a cloned repo shipping
// {"journal":{"outputDirectory":"../../victim"}} must never aim CoalHearth's
// writes or prunes outside the workspace (kept as defence in depth: a global value is contained too) (audit 2026-07-02 MED — reproduced:
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

// The default folder is the AMENDED PHOENIX #10 EXCEPTION, not a divergence (hooks-safety.md §6, row 10, amended 2026-10-04, UMB-427 ruling 1; an earlier note here called it a
// divergence, before the amendment). The row lets a hook write under os.tmpdir() and os.homedir()/.claude/, and names a third place: a tool's own project-scoped state folder,
// `<project root>/.<agent-dir>/<tool>/`, written only through a realpath-containment helper that resolves both sides with fs.realpathSync.native, refuses a candidate whose realpath is
// not inside that folder ITSELF (never merely inside the project root), fails closed, and is named in the room's shipped text. `<project root>/.claude/coalhearth/` is that folder, and
// containedOutputDir meets the row for it: when the candidate is the default folder and its realpath is not path.join(realRoot, DEFAULT_OUTPUT_DIR) (a link planted at it, or at
// `.claude` above it), the candidate is refused before anything is created, so the journal has no directory this session. hooks-safety.md §8 calls this folder "the correct location"
// (state is anchored at the project root, never at a subdirectory) and AGENTS.md, "Well-behaved OS citizen", scope note (2), keeps it at the workspace.
// Two code paths touch it, each bounded on its own. The journal's writes and prunes (and the resume engine's reads, quarantine and mark-resumed) go through containedOutputDir, and the
// ENOSPC prune (HandoffJournal._pruneOldLogs) deletes only inside a folder isOwnedDefaultDir accepts. The orphan sweep, ResumeEngine.sweepOrphans, deletes under the `scratch` and
// `worktrees` directories there (and their `.agents` twins) through its own check: it pins each owned directory to its literal location and sweeps nothing in one it refuses.
// OUTSIDE the exception: a custom `journal.outputDirectory`. Since 2.7.0 (owner BB-49 (1)) it comes from the user's GLOBAL config only; the loaders ignore a project value, so a cloned repo can no
// longer choose it. It is still contained to the PROJECT ROOT only, not pinned to the folder above, and not self-ignored; the journal writes where the user's own global config points it.
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
//
// DECIDED 2026-07-26 (station-3 LOW #3), marker-check BEFORE the home stop, deliberately:
// a `.git`-marked $HOME (dotfiles-as-a-repo) therefore anchors to home and the journal
// lands at $HOME/.claude/coalhearth. That is the right trade — $HOME/.claude is a
// Phoenix #10 SANCTIONED write root, it is ONE deterministic location rather than the
// per-subdir proliferation §8 exists to stop, and for a user whose home really is their
// repo it is the correct answer. Reversing the order would instead return null there and
// silently disable warm-resume for those users with no signal at all — a worse failure
// than one tidy directory in a sanctioned place. The home stop is "never walk ABOVE
// home", not "home can never be a project".
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
// Removes ONLY this tool's own known filenames (the `session_handoff` family, plus
// the exact `.gitignore` ensureSelfIgnore plants alongside them — LOW, station-3
// 2026-07-27: without this, self-ignore's own `.gitignore` was the one file this
// mop-up never knew about, so rmdir failed ENOTEMPTY on every legacy phantom;
// a NAMED exception, not a broadened pattern — nothing else in the dir is touched);
// rmdir is a no-op-fails (ENOTEMPTY) if anything foreign remains, so a directory
// holding a foreign file is never forced empty. Best-effort, fail-silent (Phoenix-13).
// BOTH arguments must be PHYSICAL (realpathSync.native) spellings. A raw process.cwd()
// here is a live bug, not a nit: a volume that spells one directory two ways — a
// mis-cased cwd on any case-insensitive volume, an 8.3 alias on Windows (`RUNNER~1` on
// CI) — makes raw !== resolved on the ordinary NO-DRIFT case, so this guard inverts and
// the "mop-up" deletes the journal dir containedOutputDir just created. Measured
// 2026-07-26: with a mis-cased cwd the hook wrote no journal at all.
function selfCleanLegacyPhantom(cwdAbs, anchoredRootAbs) {
  if (cwdAbs === anchoredRootAbs) return; // no drift -> the "legacy" dir IS the one we just used
  const legacyDir = path.resolve(cwdAbs, DEFAULT_OUTPUT_DIR);
  try {
    // CWK-137 (R14): this is a DELETE through a path a cloned repo can supply -- a junction or symlink at
    // <cwd>/.claude/coalhearth (or at <cwd>/.claude above it) aimed anywhere made the unlinks below land in the TARGET.
    // The pre-fix code planted a REAL directory, so only a real directory is mopped: the dir's realpath must be the very
    // path we built from the already-physical cwd. A link anywhere in the path (the leaf or any ancestor) makes them
    // differ, and the dir is left alone, untouched and unlisted. (An lstat directory check would add nothing: a link
    // never resolves to itself.) Unresolvable -> the catch below, nothing to clean.
    if (fs.realpathSync.native(legacyDir) !== legacyDir) return;
    for (const name of fs.readdirSync(legacyDir)) {
      if (name !== '.gitignore' && !name.startsWith('session_handoff')) continue; // never a foreign file
      try { fs.unlinkSync(path.join(legacyDir, name)); } catch (_) {}
    }
    fs.rmdirSync(legacyDir); // fails harmlessly (ENOTEMPTY) if a foreign file remains
  } catch (_) {
    // absent / not a dir / permission -> nothing to clean, non-fatal
  }
}

// Self-ignore (CoalWash's ensureSelfIgnore precedent, scripts/lib/apply.mjs — ported,
// USER 2026-07-27): the journal holds real user data — modified-file PATHS, goal/
// checklist/constraints text parsed from the user's own task.md/AGENTS.md, subagent
// descriptions, a transcript path (see PRIVACY.md) — so a project whose OWN
// .gitignore doesn't cover .claude/ would commit it. A LOCAL .gitignore INSIDE the
// owned output dir excludes it regardless of what the project's top-level
// .gitignore says or omits — code-enforced, not a doc promise. Exclusive create
// (wx): a race between writers is harmless (the content is identical, EEXIST is
// expected and ignored); any other error (read-only fs) is swallowed — this must
// never block the journal write it protects. Fail-silent (Phoenix-13).
//
// NOT ported: CoalWash's global-scope call writes this file directly into
// claudeBaseDir(home) (~/.claude itself) — a dir CoalWash does not exclusively own
// (every Coal* tool's global config lives there too). CH has no such call.
//
// The caller (containedOutputDir, below) gates this to ONLY the default owned dir —
// an ALLOWLIST of the one physically-resolved location, not a denylist of paths to
// avoid. HIGH, station-3 2026-07-27 (measured, not read): the first cut here WAS a
// lexical 2-value denylist (`candidate !== rootAbs && candidate !== join(rootAbs,
// '.claude')`) against `journal.outputDirectory`, untrusted per this file's own
// header. A junction/symlink named anything, aliasing back to the project root, is
// LEXICALLY distinct from both denylisted strings (passes) but PHYSICALLY resolves
// to the root — fs.writeFileSync follows a symlink at the destination
// (node/runtime.md §5), so `*` landed at the actual project root: new files vanish
// from `git status`, `git clean -fdX` deletes them, and it falsified README's "never
// your source files" claim. Same root cause as the two earlier HIGHs on this branch:
// a LEXICAL compare sitting a few lines below a REALPATH containment compare that had
// already resolved the trustworthy value — reuse that value, don't re-derive a
// second, weaker one. Fixed direction validated by the reviewer: allowlist
// `realCandidate === path.join(realRoot, DEFAULT_OUTPUT_DIR)`, both already computed
// by the containment check right above this call. A user-chosen custom
// outputDirectory therefore never gets self-ignored, even a benign one — main's
// ruling: it is not a directory CH exclusively owns, so it does not get a blanket `*`.
function ensureSelfIgnore(dir) {
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (_) {
    // EEXIST (a race, harmless — content is identical) or read-only fs etc: this
    // must never block the journal write it protects. Best-effort, fail-silent.
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
  let cwdAbs = null;
  if (autoAnchored) {
    // Resolve the cwd ONCE, physically, and reuse that value everywhere below. Never
    // read process.cwd() a second time on one side of a comparison whose other side
    // has been through realpathSync.native — that asymmetry is the false-drift bug.
    cwdAbs = physicalOrNull(process.cwd());
    root = findWorkspaceRoot(cwdAbs);
    if (!root) return null; // no real project boundary (or no resolvable cwd) -> fail-closed
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
    // 05a FIXBACK 1 (HIGH-1): the amended row 10 asks for a candidate that is the owned folder ITSELF, not merely one inside the project root. The default folder is pinned to its
    // literal location the way ResumeEngine.sweepOrphans pins scratch and worktrees: a link planted at it (or at `.claude` above it) and aimed at another directory of the project
    // resolves elsewhere, so it is refused here, before mkdir, and the loop falls through to null. Only the candidate is canonicalised, never the expectation; a differently cased
    // existing spelling never matches, which is the safe direction (no journal).
    if (candidate === path.join(rootAbs, DEFAULT_OUTPUT_DIR) && realCandidate !== path.join(realRoot, DEFAULT_OUTPUT_DIR)) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch (_) {
      continue; // blocked by a file / perms -> fall through to default / null
    }
    // Self-ignore ONLY when the PHYSICALLY-RESOLVED candidate is exactly the default
    // owned dir (main's ruling, 2026-07-27) — realCandidate/realRoot are the SAME
    // values the containment check just trusted a few lines up; reusing them means
    // self-ignore can never be fooled by anything that already fooled containment
    // wouldn't also be. See ensureSelfIgnore's header for the HIGH this replaced.
    if (realCandidate === path.join(realRoot, DEFAULT_OUTPUT_DIR)) {
      ensureSelfIgnore(candidate);
    }
    if (autoAnchored) selfCleanLegacyPhantom(cwdAbs, rootAbs);
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

// The project root the way containedOutputDir anchors it: an explicit `root` as given, resolved; with none, the nearest project marker above the physical cwd (findWorkspaceRoot), or null
// when there is none. HandoffJournal keeps this value from construction so its prune can name the root it was built for, rather than guessing one from the directory it prunes.
function anchorRoot(root) {
  if (root !== undefined) return path.resolve(root);
  const cwdAbs = physicalOrNull(process.cwd());
  const found = cwdAbs ? findWorkspaceRoot(cwdAbs) : null;
  return found ? path.resolve(found) : null;
}

// Is `dir` the OWNED default folder of the project root `root`? Two checks, both against the ROOT the caller passes and never against anything derived from `dir`: (1) `dir` is spelled
// exactly <root>/.claude/coalhearth (so an alias such as .claude/alias, a nested look-alike such as sub/.claude/coalhearth, or any custom outputDirectory is not it, even when it
// resolves into the owned folder); (2) its realpath, through realpath.native on both sides, equals path.join(realpath(root), DEFAULT_OUTPUT_DIR) (so a link at the folder, or at `.claude`
// above it, is not it). A missing argument or any error is false. The ENOSPC prune (HandoffJournal._pruneOldLogs) deletes only where this says yes.
function isOwnedDefaultDir(dir, root) {
  try {
    if (typeof dir !== 'string' || typeof root !== 'string' || !dir || !root) return false;
    if (path.resolve(dir) !== path.join(path.resolve(root), DEFAULT_OUTPUT_DIR)) return false;
    return fs.realpathSync.native(dir) === path.join(fs.realpathSync.native(root), DEFAULT_OUTPUT_DIR);
  } catch (_) {
    return false;
  }
}

// 08c unit 2 (LOW-A): containedOutputDir checks the folder ONCE, when the journal is built; a hook run is not instantaneous, and a link swapped in at the folder between that check
// and a write (SECURITY.md class 6, CHANGELOG [2.6.3] "Not covered") redirected that one run's write. makePinCheck returns the guard every write routes through: it is asked again
// at each write and answers whether the folder is STILL the one that was checked. The default folder is pinned to its literal location (isOwnedDefaultDir: two realpath.native
// calls, inside Phoenix #3's budget); a custom folder (global config) cannot be pinned to a literal, so it is pinned to the physical path it had when it was built. Any error or a
// missing folder is false (fail closed). The window between this check and the write is microseconds and is not closed; it is named in SECURITY.md.
function makePinCheck(outputDir, root) {
  if (typeof outputDir !== 'string' || !outputDir) return () => false;
  if (typeof root === 'string' && root && path.resolve(outputDir) === path.join(path.resolve(root), DEFAULT_OUTPUT_DIR)) return () => isOwnedDefaultDir(outputDir, root);
  const built = physicalOrNull(outputDir);
  return () => built !== null && physicalOrNull(outputDir) === built;
}

// Exported so a caller that wants to WARN on a blocked/escaping outputDir can first
// check whether a real project exists at all — "no project here" (a stray cwd, or a
// tool call that drifted into a subdir with nothing above it) is silent-and-expected,
// never the same "may repeat" class of problem as "a real project's journal dir is
// blocked by a file". See bin/session-start.js and bin/ag-pre-invocation.js.
module.exports = { containedOutputDir, findWorkspaceRoot, anchorRoot, isOwnedDefaultDir, makePinCheck, DEFAULT_OUTPUT_DIR };
