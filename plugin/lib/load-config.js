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
// already names for its legacy marker. ADDITIVE ONLY: each new entry can only make the
// walk stop LOWER (nearer to startDir), never widen it — verified with a real fixture
// (lib/load-config.test.js) that a subdir walk still stops at the nearer/narrower root.
const ROOT_MARKERS = [
  '.git', '.coalhearth.json',
  path.join('.claude', 'coal', 'coalhearth.json'),
  path.join('.agents', 'coal', 'coalhearth.json'),
  path.join('.gemini', 'coal', 'coalhearth.json'),
];

// Walk up from cwd for a root marker (see ROOT_MARKERS); NEVER walk above home (a config
// above the sandboxed home would leak into a hermetic test — hooks-safety §3, the
// 2026-07-01 lesson also applied in CoalBoard's findProjectCfg). Compare PHYSICAL
// paths on both sides; the walk stays lexical after that (dirname of a physical path).
function findProjectRoot(startDir, home) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
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
  candidates.push(path.join(root, '.coalhearth.json')); // LEGACY, always last
  return candidates;
}
function projectConfigPath(cwd, home, ownDir) {
  const candidates = projectConfigCandidates(cwd, home, ownDir);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0]; // nothing found anywhere -- own-dir (or .claude) is the write target
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

function readJsonc(file) {
  try {
    let content = fs.readFileSync(file, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    // proto-pollution guard (ECC ts-security / OWASP Node.js): drop __proto__/constructor/
    // prototype from an untrusted project config before it reaches merged[group] = ... ([[Set]]).
    const parsed = JSON.parse(stripJsonc(content), (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  for (const group of new Set([...Object.keys(global), ...Object.keys(project)])) {
    merged[group] = { ...(global[group] || {}), ...(project[group] || {}) };
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

module.exports = { loadConfig };
