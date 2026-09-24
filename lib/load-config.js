// CoalHearth config loader (CJS — for the bin/ hooks, which require() not import()).
// Mirrors scripts/lib/config-load.mjs 1:1 (same walk-stop-at-home + JSONC + merge
// logic); duplicated rather than shared because bin/ hooks are CJS and
// scripts/lib/*.mjs is ESM — no build step exists to bridge them (ponytail: two
// small sync file readers, not worth a shared-module refactor for this pair).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function stripJsonc(content) {
  return content.replace(/"(?:\\.|[^"\\])*"|\/\/.*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
}

function claudeBaseDir(home) {
  const c = process.env.CLAUDE_CONFIG_DIR;
  return (c && c.split(',')[0].trim()) || path.join(home, '.claude');
}

function globalConfigPath(home) {
  return path.join(claudeBaseDir(home), '.coalhearth.json');
}

// realpath a dir to its PHYSICAL path, falling back to a lexical resolve if realpath
// throws (an absent dir has no realpath). On macOS os.tmpdir()/HOME is a symlink:
// process.cwd() returns the realpath (/private/var/...) while os.homedir() returns the
// raw symlink (/var/...), so a lexical `dir === homeAbs` NEVER matches and the walk
// escapes above home. Same realpath discipline as sweepOrphans/_pruneOldLogs
// (beta.3/beta.4); same fix as CoalFace v0.1.0-beta.2. Read-only + fail-open —
// Phoenix-13 safe.
function physical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Root markers a project can be anchored by. `.git` + the legacy `.coalhearth.json`
// are the original two; the three `.<agent-dir>/coal/coalhearth.json` paths were added
// by the namespace campaign (#69+#39, owner-designated 2026-08-08) alongside them — a
// project configured ONLY through the new shape (no `.git`, and — since it migrated —
// no root `.coalhearth.json` either) would otherwise match NOTHING and fall through to
// the raw `startDir` fallback, the same per-subdir-scatter class CoalWash's own history
// already names for its legacy marker. ADDITIVE ONLY WITH RESPECT TO AN EXISTING MARKER
// MATCH: where the previous marker set already matched a directory, a new entry can only
// make the walk stop there or NEARER (never skip past it to a farther root) — verified with
// a real fixture (lib/load-config.test.js) that a subdir walk still stops at the nearer/narrower
// root. Where the previous set matched NOTHING, a new marker deliberately anchors HIGHER than
// the raw `startDir` fallback — that is the point of the entries above, not a violation, and
// a test for a further marker must not assert otherwise.
const ROOT_MARKERS = [
  '.git', '.coalhearth.json',
  path.join('.claude', 'coal', 'coalhearth.json'),
  path.join('.agents', 'coal', 'coalhearth.json'),
  path.join('.gemini', 'coal', 'coalhearth.json'),
];
// UMB-133 RULING — `.claude/.coalhearth.json` (the nested LEGACY shape) is deliberately NOT
// a root marker, though the root legacy `.coalhearth.json` is. Reason: at home that exact
// path IS the GLOBAL config (globalConfigPath). Marker checks run BEFORE the stop-at-home
// test, so with it listed every no-`.git` walk that reaches home would anchor AT home, and
// the project's "nested legacy" would be the global file read a second time. What it costs
// to leave it out: a no-`.git` project anchored ONLY by a nested-legacy file, run from a
// SUBDIR, resolves to that subdir and misses it (from the project root it is still found).
// That is a deprecated shape with no `.git` and no canonical file — accepted, and named in
// the UMB-133 return. Adding it and cutting it back at home would be a special case for a
// shape we are retiring. Pinned by lib/load-config.test.js's ROOT_MARKERS-ruling test.

// CWK-127 (INSPECT L2): a config path counts only if it is a FILE. The walk used to select on
// existsSync while the IGNORED probe (below) used isFile, so a DIRECTORY named like a config won
// the walk, read as {}, and shadowed the real config beneath it -- and the LEGACY notice then
// claimed the directory was "still read". Every site that asks "is there a config here" now asks
// isFile: the marker test in findProjectRoot and the selector in resolveProjectConfig. `.git` is
// the one exception on purpose -- a worktree's .git is a FILE and a normal repo's a directory,
// and either anchors the root. Exemplar for the class: CoalLedger 0998432.
function isMarker(dir, marker) {
  const p = path.join(dir, marker);
  return marker === '.git' ? fs.existsSync(p) : isFile(p);
}
// Walk up from cwd for a root marker (see ROOT_MARKERS); NEVER walk above home (a config
// above the sandboxed home would leak into a hermetic test — hooks-safety §3, the
// 2026-07-01 lesson also applied in CoalBoard's findProjectCfg). Compare PHYSICAL
// paths on both sides; the walk stays lexical after that (dirname of a physical path).
function findProjectRoot(startDir, home) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (ROOT_MARKERS.some((m) => isMarker(dir, m))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

// Namespace campaign (#69+#39, owner-designated 2026-08-08). Per-project config lives
// under an agent dir, never bare at the project root any more. THE READ ORDER IS A
// RAIL — identical wording in every room's readCfg comment and README Configure
// section, one flock:
//   1. <project>/.<the running agent's OWN dir>/coal/coalhearth.json — the dir of the
//      agent actually executing.
//   2. Other known agent dirs, fixed order: `.claude` -> `.agents` -> `.gemini` (first
//      FOUND wins).
//   3. LEGACY, in this order (UMB-133 unified the list across the flock): first
//      <project>/.claude/.coalhearth.json (nested), then <project>/.coalhearth.json at
//      the project root — both read normally, no breakage for an existing user, both
//      DEPRECATED. A hit is named on the SessionStart channel ONLY (configNotices, below):
//      bin/session-start.js rides an emission the hook is already making, or prints the
//      notice standalone when the session would otherwise be silent — the same
//      sanctioned channel either way — never by any other hook (Phoenix #13).
// WRITE target = where the config was found; absent everywhere, the running agent's
// own dir. The HOOKS never write config and never perform the legacy -> canonical move on
// a READ (Phoenix #5, no side effects): nothing under bin/ or lib/ writes a
// `.coalhearth.json`, global or project, and there is no consent-persistence call. The one
// WRITER is scripts/configure.mjs, a USER-INVOKED CLI that no hook runs: it writes the
// project config where it was found (or the global one with --global), and it is what
// performs "move on write" — a config found at EITHER legacy path is written to the
// canonical own-dir file and the legacy one removed (UMB-133 added the nested legacy to
// that migration). It reads through this walk's ESM twin, scripts/lib/config-load.mjs. So
// this file is the READ side only; the write side lives in configure.mjs.
//
// NAMED DIVERGENCE from CoalWash's own version of this comment (which collapses "own
// dir" onto `.claude`, because CoalWash activates ONLY through Claude Code's hook
// system): CoalHearth does NOT collapse it. Unlike CoalWash, loadConfig() is called
// from MULTIPLE platform-specific entry points sharing this one codebase —
// bin/session-start.js (Claude Code) plus bin/ag-pre-invocation.js / bin/ag-post-tool-
// use.js, which the SAME argv-mode dispatch routes to Antigravity, Gemini CLI, or 4
// more file-copy platforms (see those files' own headers). Hardcoding `.claude` as
// "own dir" here would be wrong whenever the running agent is Gemini CLI (own dir
// `.gemini`) or Antigravity (own dir `.agents`, this flock's cross-agent-neutral
// convention — matches AG's own `<workspace>/.agents/hooks.json` wiring target) —
// exactly the multi-agent scenario the design doc names (a project holding BOTH
// `.claude/` and `.agents/`, e.g. this series' own umbrella repo). So `ownDir` is a
// PARAMETER, not a hardcoded constant: the CALLER states which agent is actually
// running. bin/session-start.js and the FileCopy-mode branch of the AG-dispatch entry
// points (4 platforms with no clean match in the .claude/.agents/.gemini set) omit it
// and get the `.claude`-first default — a no-op change from today's behavior, and a
// named, accepted gap: those platforms fall through to step 2's fixed order like
// everyone else. Gemini-mode and AG-mode pass their own dir explicitly — see
// bin/ag-pre-invocation.js / bin/ag-post-tool-use.js.
const AGENT_DIR_ORDER = ['.claude', '.agents', '.gemini'];
function projectConfigCandidates(cwd, home, ownDir) {
  const root = findProjectRoot(cwd, home);
  const order = ownDir && AGENT_DIR_ORDER.includes(ownDir)
    ? [ownDir, ...AGENT_DIR_ORDER.filter((d) => d !== ownDir)]
    : AGENT_DIR_ORDER;
  const candidates = order.map((d) => path.join(root, d, 'coal', 'coalhearth.json'));
  candidates.push(path.join(root, '.claude', '.coalhearth.json')); // LEGACY (nested) — UMB-133
  candidates.push(path.join(root, '.coalhearth.json')); // LEGACY (root), always last
  return candidates;
}
// `<home>/.claude/.coalhearth.json` IS the global config. A project rooted at home (cwd at
// home, or a walk that lands there) would see it as its own nested legacy — never let the
// global file pass for a project one (it would be merged with itself and reported as a
// legacy hit). Identity compare by realpath.native (node/runtime.md 4); unresolvable = no.
function isGlobalConfig(file, home) {
  try { return fs.realpathSync.native(file) === fs.realpathSync.native(globalConfigPath(home)); } catch { return false; }
}
// The file the walk reads (first existing candidate that is not the global config), or null.
function resolveProjectConfig(cwd, home, ownDir) {
  const candidates = projectConfigCandidates(cwd, home, ownDir);
  const found = candidates.find((c) => isFile(c) && !isGlobalConfig(c, home)) || null; // CWK-127: a file, never a directory
  return { candidates, found };
}
function projectConfigPath(cwd, home, ownDir) {
  const { candidates, found } = resolveProjectConfig(cwd, home, ownDir);
  return found || candidates[0]; // nothing found anywhere -- own-dir (or .claude) is the write target
}

// UMB-133 hole (1) + (2): REPORT, never skip. Lines for a SessionStart hook to emit —
// appended to an emission it is already making, or on their own when it would otherwise say
// nothing; this function itself prints nothing and never throws
// (Phoenix #4 — a probe that fails yields [], not a dead hook).
//   LEGACY  — the config actually read is one of the two deprecated shapes.
//   IGNORED — a file named like ours sits at a path that is NOT a candidate.
// THE PROBE IS A CLOSED SET, not a crawl: the cross product of {the project root, then
// .claude/.agents/.gemini beneath it} x {directly, or under coal/} x {coalhearth.json,
// .coalhearth.json} — 16 paths, all under the ONE root findProjectRoot resolved (the root
// the walk above already reads) — minus the candidates themselves (canonical x3, nested and
// root legacy). It is closed by construction: every shape a user could get wrong by
// recombining the parts of the canonical path, and nothing else. Not probed, deliberately:
// the global dir (one path, one shape, out of scope for this unit), any other directory, and
// a legacy file SHADOWED by a canonical one (it was migrated; a leftover copy is a cleanup,
// not a silently dead config).
// Wording: `IGNORED: <path> is not a config path; canonical = <own-dir>/coal/coalhearth.json`
// (the flock's shape, UMB-133); the canonical path is the running agent's own dir.
// UMB-174 (b) adds a THIRD line, UNREADABLE: a config that EXISTS where the walk reads but cannot be
// turned into a config (see readConfigFile for the four reasons) -- the class UMB-133 closed for a
// wrong PATH, closed for a wrong BODY. One line per path the walk STEPPED ON: the global config, each
// directory it stepped over before the winner, and the winner itself if it fails to read. Only paths the
// walk already stats -- never a crawl. Wording (ONE flock string, every room verbatim):
//   UNREADABLE: <path> exists but is not a readable config (<reason>); it was skipped \u2014 canonical = <canonical>
// An unreadable LEGACY winner is UNREADABLE only, never also LEGACY: a file that failed to parse was
// not "still read", and saying so would be a second false statement in one line.
const CONFIG_NAMES = ['coalhearth.json', '.coalhearth.json'];
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function configNotices(opts) {
  try {
    const cwd = (opts && opts.cwd) || process.cwd();
    const home = (opts && opts.home) || os.homedir();
    const ownDir = opts && opts.ownDir;
    const root = findProjectRoot(cwd, home);
    const { candidates, found } = resolveProjectConfig(cwd, home, ownDir);
    const canonical = path.relative(root, candidates[0]).split(path.sep).join('/');
    const lines = [];
    const unreadable = (p, reason) => 'UNREADABLE: ' + p + ' exists but is not a readable config (' + reason + '); it was skipped \u2014 canonical = ' + canonical;
    const globalPath = globalConfigPath(home);
    const globalRead = readConfigFile(globalPath);
    if (globalRead.reason) lines.push(unreadable(globalPath, globalRead.reason));
    let foundReason = null;
    for (const c of candidates) {
      if (c === found) { foundReason = readConfigFile(c).reason; if (foundReason) lines.push(unreadable(c, foundReason)); break; }
      if (isDirectory(c)) lines.push(unreadable(c, 'a directory')); // the walk stepped over it (CWK-127)
    }
    if (found && !foundReason && candidates.slice(-2).includes(found)) {
      lines.push('LEGACY: ' + found + ' is deprecated but still read; canonical = ' + canonical);
    }
    const known = new Set(candidates.map((c) => path.resolve(c)));
    for (const d of ['', ...AGENT_DIR_ORDER]) {
      for (const sub of ['', 'coal']) {
        for (const name of CONFIG_NAMES) {
          const p = path.join(root, d, sub, name);
          if (!known.has(path.resolve(p)) && isFile(p)) lines.push('IGNORED: ' + p + ' is not a config path; canonical = ' + canonical);
        }
      }
    }
    return lines;
  } catch {
    return [];
  }
}

// Consent-cascade clamp (hooks-safety.md §9, USER 2026-07-27, amended R2 2026-07-27):
// the project config ARRIVES WITH A CLONED REPO — untrusted. update.updateMode and
// recovery.autoInjectPrompt are CH's two hook-read keys that gate an outward action
// (the periodic self-update nudge; the whole recovery-block injection). A plain
// project-wins overlay would let either ESCALATE a user's own quiet global setting
// back on. The project layer may only QUIETEN, never escalate — every other config
// key (caps, paths, atomicityRetries, stashUnsavedChanges — see the SEPARATE R3 note
// on that one below) stays plain project-wins.
//
// R2: a user who never wrote a GLOBAL config still has a stance — the schema's
// declared default IS it (Default ask / Default true, scripts/lib/config-schema.mjs).
// An absent global ranks as that default when computing the safer index; it must
// never skip the clamp entirely (the first cut here did exactly that — measured:
// no-global + project 'auto' returned 'auto' uncalmped).
//
// updateMode loudness (least autonomous action taken on the user's behalf -> most):
// off (no nudge at all) < remind (pure info, the agent takes no action) < ask (an
// interactive decision) < auto (standing consent to check+offer). An unrecognized
// string ranks as loudest so it can never win over a real, quieter, trusted value.
const UPDATE_MODE_LOUDNESS = { off: 0, remind: 1, ask: 2, auto: 3 };
const SCHEMA_DEFAULT_UPDATE_MODE = 'ask';
function quieterUpdateMode(globalMode, projectMode) {
  if (typeof projectMode !== 'string') return globalMode; // project didn't touch it -> nothing to clamp
  const g = typeof globalMode === 'string' ? globalMode : SCHEMA_DEFAULT_UPDATE_MODE; // R2
  const rank = (m) => (Object.prototype.hasOwnProperty.call(UPDATE_MODE_LOUDNESS, m.toLowerCase()) ? UPDATE_MODE_LOUDNESS[m.toLowerCase()] : UPDATE_MODE_LOUDNESS.auto);
  return rank(projectMode) < rank(g) ? projectMode : g;
}

// R3 (hooks-safety.md §9): recovery.autoInjectPrompt is CH's SECOND hook-read consent
// key (bin/session-start.js + bin/ag-pre-invocation.js) — it gates the ENTIRE
// recovery-block injection (a multi-hundred-token spend plus an agent directive),
// strictly more blast than CoalLedger's docLeak which §9 already rules must be
// clamped. Loudness: true (inject) is louder than false (silent detect+sweep) — a
// project may only quieten true->false, never escalate false->true; boolean AND is
// exactly that. R2 applies here too: an unset global ranks as the schema default
// (true) rather than skipping the clamp.
//
// recovery.stashUnsavedChanges is DELIBERATELY NOT clamped here — kept as its OWN,
// SEPARATE reasoning per §9's own note that a shared parenthetical is what hid a
// sibling's asymmetry: it gates one advisory TEXT LINE (a "consider git stash"
// suggestion) in the recovery block, never an offer, a scan, or any spend — the
// docsDriftNudge analogue. Stays plain project-wins, same as caps/paths.
const SCHEMA_DEFAULT_AUTO_INJECT = true;
function quieterAutoInjectPrompt(globalValue, projectValue) {
  if (typeof projectValue !== 'boolean') return globalValue;
  const g = typeof globalValue === 'boolean' ? globalValue : SCHEMA_DEFAULT_AUTO_INJECT; // R2
  return g && projectValue;
}

// UMB-174 (b): read + classify ONE config file -> { cfg, reason }. `reason` is null when the
// file is absent (the normal, silent case) or read fine; otherwise it is the flock's reason a
// PRESENT config could not be used: 'malformed JSON' | 'a directory' | 'unreadable' (BOTH EACCES
// and EPERM -- a Windows ACL denial surfaces as EPERM, and a room that maps EACCES alone stays
// silent there) | 'not a JSON object' (valid JSON that is not a plain object: an array, a
// string, a number, null). Branches on the fs error's CODE, never its message (node/runtime.md
// 7). Any OTHER fs error stays silent (a race, an exotic code) -- never a fifth reason invented
// for it. `cfg` is {} in every failure case: the SELECTION is unchanged, an unreadable candidate
// still wins the walk and contributes nothing, exactly as before this report existed. A leading
// U+FEFF is STRIPPED before the parse (RFC 8259 s8.1 lets a parser ignore a BOM; Windows
// PowerShell 5.1 writes one whenever asked for UTF-8), so a BOM-prefixed VALID object is read
// and never reported as malformed. Exemplar: CoalFace v0.12.0 / CoalTipple.
function readConfigFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && e.code;
    if (code === 'EISDIR') return { cfg: {}, reason: 'a directory' };
    if (code === 'EACCES' || code === 'EPERM') return { cfg: {}, reason: 'unreadable' };
    return { cfg: {}, reason: null };
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  let parsed;
  try {
    // proto-pollution guard (ECC ts-security / OWASP Node.js): drop __proto__/constructor/
    // prototype from an untrusted project config before it reaches merged[group] = ... ([[Set]]).
    parsed = JSON.parse(stripJsonc(content), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    return { cfg: {}, reason: 'malformed JSON' };
  }
  if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) return { cfg: {}, reason: 'not a JSON object' };
  return { cfg: parsed, reason: null };
}
function readJsonc(file) {
  return readConfigFile(file).cfg;
}

/**
 * Loads + shallow-per-group-merges the global (~/.claude/.coalhearth.json) and
 * project config (namespace-campaign read order — see projectConfigPath's own
 * header comment; walk stops at home). Fail-silent: any read/parse error degrades
 * to {} for that file, never throws.
 * @param {{cwd?: string, home?: string, ownDir?: string}} [opts] ownDir = the
 *   running agent's own dir (e.g. '.gemini', '.agents'); omitted -> '.claude'-first
 *   default (correct for Claude Code and the FileCopy-mode platforms).
 */
function loadConfig(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const home = (opts && opts.home) || os.homedir();
  const ownDir = opts && opts.ownDir;
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(projectConfigPath(cwd, home, ownDir));
  const merged = {};
  // AL-2 added a top-level SCALAR key (`language`) alongside the existing nested groups
  // (journal/recovery/update). Spreading a scalar as though it were a group object is a
  // real bug, not a hypothetical one -- `{...'auto'}` explodes a string into indexed
  // characters (`{0:'a',1:'u',...}`). A key is a GROUP here iff its value is a genuine
  // object (not null, not an array) on the side that actually supplies it.
  //
  // r29 findings-back LOW 3: a MIXED tier (one side a group, the OTHER side PRESENT but
  // not a group -- a malformed config, e.g. project `language: {}` against a schema that
  // wants a string) used to fall through to the per-key merge branch below regardless,
  // which silently DISCARDS whichever side is not object-shaped -- `{...g, ...{}}` drops a
  // present, wrong-shaped `p` entirely, and the reverse drops a present `g`. That is not
  // project-wins, it is object-shape-wins, and it can discard the tier that should have
  // won. Per-key group merging is only MEANINGFUL when BOTH sides are real groups; the
  // moment either present side is not a group, there is no key-by-key merge to perform --
  // the two sides disagree on what KIND of value this key even is, so the key resolves as
  // ONE ATOM, plain project-wins, exactly like a scalar-vs-scalar disagreement already did.
  // A side that is simply ABSENT (undefined, never touched this tier) is not part of that
  // disagreement -- it still yields a FRESH per-key copy of whichever real group remains,
  // preserving the immutability guarantee below (never hand back a shared reference into
  // `global`/`project`).
  for (const key of new Set([...Object.keys(global), ...Object.keys(project)])) {
    const g = global[key];
    const p = project[key];
    const gIsGroup = g && typeof g === 'object' && !Array.isArray(g);
    const pIsGroup = p && typeof p === 'object' && !Array.isArray(p);
    if (gIsGroup && pIsGroup) {
      merged[key] = { ...g, ...p };
    } else if (gIsGroup && p === undefined) {
      merged[key] = { ...g };
    } else if (pIsGroup && g === undefined) {
      merged[key] = { ...p };
    } else {
      merged[key] = p !== undefined ? p : g;
    }
  }
  // Post-clamp ONLY updateMode + autoInjectPrompt (see the two functions above) —
  // every other key in every group keeps the plain project-wins merge just performed.
  if (merged.update) {
    const g = global.update && global.update.updateMode;
    const p = project.update && project.update.updateMode;
    if (typeof g === 'string' || typeof p === 'string') merged.update.updateMode = quieterUpdateMode(g, p);
  }
  if (merged.recovery) {
    const g = global.recovery && global.recovery.autoInjectPrompt;
    const p = project.recovery && project.recovery.autoInjectPrompt;
    if (typeof g === 'boolean' || typeof p === 'boolean') merged.recovery.autoInjectPrompt = quieterAutoInjectPrompt(g, p);
  }
  return merged;
}

module.exports = { loadConfig, configNotices, findProjectRoot, projectConfigCandidates, projectConfigPath };
