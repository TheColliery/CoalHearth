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
// already names for its legacy marker. ADDITIVE ONLY: each new entry can only make the
// walk stop LOWER (nearer to startDir), never widen it — verified with a real fixture
// (config-load.test.mjs) that a subdir walk still stops at the nearer/narrower root.
const ROOT_MARKERS = [
  '.git', '.coalhearth.json',
  path.join('.claude', 'coal', 'coalhearth.json'),
  path.join('.agents', 'coal', 'coalhearth.json'),
  path.join('.gemini', 'coal', 'coalhearth.json'),
];

// Walk up from startDir looking for a root marker (see ROOT_MARKERS); NEVER walk above
// `home` — stop there and fall back to startDir. Compare PHYSICAL paths on both sides;
// the walk stays lexical after that (dirname of a physical path).
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
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
//   3. LEGACY: <project>/.coalhearth.json at the project root (today's shape) — read
//      normally, no breakage for an existing user.
// WRITE target = where the config was found; absent everywhere, the running agent's
// own dir. Hooks never perform this move on a READ (Phoenix #5, no side effects) — and
// CoalHearth has NO project-config WRITER anywhere in this codebase to begin with (no
// configure.mjs, no consent-persistence call): `.coalhearth.json`, global and project,
// is hand-edited by the user or another tool, never written by CoalHearth itself. So
// "move on write" has no code path to hook here — this is the READ side only.
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
  candidates.push(path.join(root, '.coalhearth.json')); // LEGACY, always last
  return candidates;
}
export function projectConfigPath(cwd = process.cwd(), home = os.homedir(), ownDir) {
  const candidates = projectConfigCandidates(cwd, home, ownDir);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]; // nothing found anywhere -- own-dir (or .claude) is the write target
}

function readJsonc(file) {
  try {
    let content = fs.readFileSync(file, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    const parsed = parseJsonc(content); // proto-pollution-guarded parse (drops __proto__/constructor/prototype)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
