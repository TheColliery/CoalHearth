// CoalHearth config path resolution. Mirrors CoalTipple's config-load.mjs shape,
// but the project-config walk STOPS AT HOME (2026-07-01 lesson: an upward config
// search that doesn't stop at home can escape a HOME-overridden test sandbox and
// hit the real ~/.claude/.coalhearth.json — see CoalBoard's hermetic-test-isolation-leak).
//
// Pure + node built-ins only (fs, path, os).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseJsonc } from './jsonc.mjs';

export function claudeBaseDir(home = os.homedir()) {
  const c = process.env.CLAUDE_CONFIG_DIR;
  return (c && c.split(',')[0].trim()) || path.join(home, '.claude');
}
export function globalConfigPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), '.coalhearth.json');
}

// realpath a dir to its PHYSICAL path, falling back to a lexical resolve if realpath
// throws (an absent dir has no realpath). On macOS os.tmpdir()/HOME is a symlink:
// process.cwd() returns the realpath (/private/var/...) while os.homedir() returns the
// raw symlink (/var/...), so a lexical `dir === homeAbs` NEVER matches and the walk
// escapes above home. Same realpath discipline as sweepOrphans/_pruneOldLogs
// (beta.3/beta.4); same fix as CoalFace v0.1.0-beta.2.
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
// a real fixture (config-load.test.mjs) that a subdir walk still stops at the nearer/narrower
// root. Where the previous set matched NOTHING, a new marker deliberately anchors HIGHER than
// the raw `startDir` fallback — that is the point of the entries above, not a violation, and
// a test for a further marker must not assert otherwise.
const ROOT_MARKERS = [
  '.git', '.coalhearth.json',
  path.join('.claude', 'coal', 'coalhearth.json'),
  path.join('.agents', 'coal', 'coalhearth.json'),
  path.join('.gemini', 'coal', 'coalhearth.json'),
];
// UMB-133 RULING (mirrors lib/load-config.js 1:1 — see its comment for the full reasoning):
// `.claude/.coalhearth.json` (the nested LEGACY shape) is deliberately NOT a root marker,
// because at home that exact path IS the global config (globalConfigPath) and marker checks
// run before the stop-at-home test. Cost accepted: a no-`.git` project anchored ONLY by a
// nested-legacy file, run from a SUBDIR, resolves to that subdir and misses it.
// Pinned by the ROOT_MARKERS-ruling test in config-load.test.mjs.

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
// Walk up from startDir looking for a root marker (see ROOT_MARKERS); NEVER walk above
// `home` — stop there and fall back to startDir. Compare PHYSICAL paths on both sides;
// the walk stays lexical after that (dirname of a physical path).
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (ROOT_MARKERS.some((m) => isMarker(dir, m))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // filesystem root reached
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
//      the shipped bin/session-start.js rides an emission the hook is already making, or
//      prints the notice standalone when the session would otherwise be silent — the
//      same sanctioned channel either way — never by any other hook (Phoenix #13).
// WRITE target = where the config was found; absent everywhere, the running agent's
// own dir. The HOOKS never write config and never perform the legacy -> canonical move on
// a READ (Phoenix #5, no side effects): nothing under bin/ or lib/ writes a
// `.coalhearth.json`, global or project, and there is no consent-persistence call. The one
// WRITER is scripts/configure.mjs, a USER-INVOKED CLI that no hook runs and that imports
// THIS module for its walk: it writes the project config where it was found (or the global
// one with --global), and it is what performs "move on write" — a config found at EITHER
// legacy path is written to the canonical own-dir file and the legacy one removed (UMB-133
// added the nested legacy to that migration). So this file is the READ side only; the
// write side lives in configure.mjs.
//
// NAMED DIVERGENCE from CoalWash's own version of this comment (which collapses "own
// dir" onto `.claude`, because CoalWash activates ONLY through Claude Code's hook
// system): CoalHearth does NOT collapse it — see lib/load-config.js's mirror of this
// same comment for the full reasoning (this room's shared runtime code is called from
// multiple platform-specific entry points; ownDir is a caller-supplied parameter here
// too, for the same reason).
const AGENT_DIR_ORDER = ['.claude', '.agents', '.gemini'];
export function projectConfigCandidates(cwd = process.cwd(), home = os.homedir(), ownDir) {
  const root = findProjectRoot(cwd, home);
  const order = ownDir && AGENT_DIR_ORDER.includes(ownDir)
    ? [ownDir, ...AGENT_DIR_ORDER.filter((d) => d !== ownDir)]
    : AGENT_DIR_ORDER;
  const candidates = order.map((d) => path.join(root, d, 'coal', 'coalhearth.json'));
  candidates.push(path.join(root, '.claude', '.coalhearth.json')); // LEGACY (nested) — UMB-133
  candidates.push(path.join(root, '.coalhearth.json')); // LEGACY (root), always last
  return candidates;
}
// `<home>/.claude/.coalhearth.json` IS the global config — never let it pass for a project
// one (mirrors lib/load-config.js; see its comment). Identity compare by realpath.native.
function isGlobalConfig(file, home) {
  try { return fs.realpathSync.native(file) === fs.realpathSync.native(globalConfigPath(home)); } catch { return false; }
}
function resolveProjectConfig(cwd, home, ownDir) {
  const candidates = projectConfigCandidates(cwd, home, ownDir);
  const found = candidates.find((c) => isFile(c) && !isGlobalConfig(c, home)) || null; // CWK-127: a file, never a directory
  return { candidates, found };
}
export function projectConfigPath(cwd = process.cwd(), home = os.homedir(), ownDir) {
  const { candidates, found } = resolveProjectConfig(cwd, home, ownDir);
  return found || candidates[0]; // nothing found anywhere -- own-dir (or .claude) is the write target
}

// UMB-133 holes (1)+(2): the LEGACY / IGNORED lines — mirrors lib/load-config.js's
// configNotices 1:1 (its comment carries the closed-set reasoning and what is deliberately
// not probed). Prints nothing, never throws. The shipped hook is the only caller; this twin
// exists so the tooling side answers the same walk identically, and so the agreement test in
// config-load.test.mjs can hold the two to one behaviour.
const CONFIG_NAMES = ['coalhearth.json', '.coalhearth.json'];
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
export function configNotices(opts) {
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
    parsed = parseJsonc(content); // proto-pollution-guarded parse (drops __proto__/constructor/prototype)
  } catch {
    return { cfg: {}, reason: 'malformed JSON' };
  }
  if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) return { cfg: {}, reason: 'not a JSON object' };
  return { cfg: parsed, reason: null };
}
function readJsonc(file) {
  return readConfigFile(file).cfg;
}

// Consent-cascade clamp (hooks-safety.md §9, USER 2026-07-27, amended R2) — mirrors
// lib/load-config.js 1:1. See that file's comments for the full rationale (R2
// factory-default ranking, R3's separate autoInjectPrompt reasoning, why
// stashUnsavedChanges stays out of scope).
const UPDATE_MODE_LOUDNESS = { off: 0, remind: 1, ask: 2, auto: 3 };
const SCHEMA_DEFAULT_UPDATE_MODE = 'ask';
function quieterUpdateMode(globalMode, projectMode) {
  if (typeof projectMode !== 'string') return globalMode;
  const g = typeof globalMode === 'string' ? globalMode : SCHEMA_DEFAULT_UPDATE_MODE; // R2
  const rank = (m) => (Object.prototype.hasOwnProperty.call(UPDATE_MODE_LOUDNESS, m.toLowerCase()) ? UPDATE_MODE_LOUDNESS[m.toLowerCase()] : UPDATE_MODE_LOUDNESS.auto);
  return rank(projectMode) < rank(g) ? projectMode : g;
}

const SCHEMA_DEFAULT_AUTO_INJECT = true;
function quieterAutoInjectPrompt(globalValue, projectValue) {
  if (typeof projectValue !== 'boolean') return globalValue;
  const g = typeof globalValue === 'boolean' ? globalValue : SCHEMA_DEFAULT_AUTO_INJECT; // R2
  return g && projectValue;
}

// Shallow-per-group merge: project group overwrites global group key-by-key. ownDir =
// the running agent's own dir (e.g. '.gemini', '.agents'); omitted -> '.claude'-first
// default. See projectConfigPath's own header for the full read-order rail.
//
// AL-2 added a top-level SCALAR key (`language`) alongside the existing nested groups
// (journal/recovery/update) -- mirrored from lib/load-config.js's identical fix. Spreading
// a scalar as though it were a group object is a real bug, not a hypothetical one --
// `{...'auto'}` explodes a string into indexed characters (`{0:'a',1:'u',...}`). A key is a
// GROUP here iff its value is a genuine object (not null, not an array) on the side that
// actually supplies it.
//
// r29 findings-back LOW 3 (mirrored 1:1 from lib/load-config.js): a MIXED tier (one side a
// group, the OTHER side PRESENT but not a group -- a malformed config, e.g. project
// `language: {}` against a schema that wants a string) used to fall through to the per-key
// merge branch below regardless, silently DISCARDING whichever side is not object-shaped --
// `{...g, ...{}}` drops a present, wrong-shaped `p` entirely, and the reverse drops a
// present `g`. That is not project-wins, it is object-shape-wins, and it can discard the
// tier that should have won. Per-key group merging is only MEANINGFUL when BOTH sides are
// real groups; the moment either present side is not a group, there is no key-by-key merge
// to perform -- the two sides disagree on what KIND of value this key even is, so the key
// resolves as ONE ATOM, plain project-wins, exactly like a scalar-vs-scalar disagreement
// already did. A side that is simply ABSENT (undefined, never touched this tier) is not
// part of that disagreement -- it still yields a FRESH per-key copy of whichever real group
// remains, preserving the immutability guarantee (never hand back a shared reference into
// `global`/`project`).
export function loadMergedConfig({ cwd = process.cwd(), home = os.homedir(), ownDir } = {}) {
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(projectConfigPath(cwd, home, ownDir));
  const merged = {};
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
  // Post-clamp ONLY updateMode + autoInjectPrompt — every other key in every group
  // keeps the plain project-wins merge just performed.
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
