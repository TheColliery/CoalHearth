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

// Walk up from startDir looking for `.coalhearth.json` or `.git` (project root
// marker); NEVER walk above `home` — stop there and fall back to startDir. Compare
// PHYSICAL paths on both sides; the walk stays lexical after that (dirname of a
// physical path).
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.coalhearth.json'))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // filesystem root reached
    dir = parent;
  }
}
export function projectConfigPath(cwd = process.cwd(), home = os.homedir()) {
  return path.join(findProjectRoot(cwd, home), '.coalhearth.json');
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

// Shallow-per-group merge: project group overwrites global group key-by-key.
export function loadMergedConfig({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(projectConfigPath(cwd, home));
  const merged = {};
  for (const group of new Set([...Object.keys(global), ...Object.keys(project)])) {
    merged[group] = { ...(global[group] || {}), ...(project[group] || {}) };
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
