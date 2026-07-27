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

// Walk up from cwd for `.coalhearth.json` / `.git`; NEVER walk above home (a config
// above the sandboxed home would leak into a hermetic test — hooks-safety §3, the
// 2026-07-01 lesson also applied in CoalBoard's findProjectCfg). Compare PHYSICAL
// paths on both sides; the walk stays lexical after that (dirname of a physical path).
function findProjectRoot(startDir, home) {
  let dir = physical(startDir);
  const homeAbs = physical(home);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.coalhearth.json'))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

// Consent-cascade clamp (hooks-safety.md §9, USER 2026-07-27): the project config
// ARRIVES WITH A CLONED REPO — untrusted. update.updateMode is CH's one hook-read key
// that gates an outward action (the periodic self-update nudge); a plain project-wins
// overlay would let it ESCALATE a user's own off/quiet global setting back on. The
// project layer may only QUIETEN it, never escalate — every other config key (caps,
// paths, atomicityRetries, stashUnsavedChanges) stays plain project-wins.
// Loudness order (least autonomous action taken on the user's behalf -> most): off (no
// nudge at all) < remind (pure info, the agent takes no action) < ask (an interactive
// decision) < auto (standing consent to check+offer). An unrecognized string is ranked
// as loudest so it can never win over a real, quieter, trusted value.
const UPDATE_MODE_LOUDNESS = { off: 0, remind: 1, ask: 2, auto: 3 };
function quieterUpdateMode(globalMode, projectMode) {
  if (typeof projectMode !== 'string') return globalMode;
  if (typeof globalMode !== 'string') return projectMode;
  const rank = (m) => (Object.prototype.hasOwnProperty.call(UPDATE_MODE_LOUDNESS, m.toLowerCase()) ? UPDATE_MODE_LOUDNESS[m.toLowerCase()] : UPDATE_MODE_LOUDNESS.auto);
  return rank(projectMode) < rank(globalMode) ? projectMode : globalMode;
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
 * project (nearest .coalhearth.json, walk stops at home) config. Fail-silent:
 * any read/parse error degrades to {} for that file, never throws.
 * @param {{cwd?: string, home?: string}} [opts]
 */
function loadConfig(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const home = (opts && opts.home) || os.homedir();
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(path.join(findProjectRoot(cwd, home), '.coalhearth.json'));
  const merged = {};
  for (const group of new Set([...Object.keys(global), ...Object.keys(project)])) {
    merged[group] = { ...(global[group] || {}), ...(project[group] || {}) };
  }
  // Post-clamp ONLY updateMode (see quieterUpdateMode above) — every other key in
  // every group keeps the plain project-wins merge just performed.
  if (merged.update) {
    const g = global.update && global.update.updateMode;
    const p = project.update && project.update.updateMode;
    if (typeof g === 'string' || typeof p === 'string') merged.update.updateMode = quieterUpdateMode(g, p);
  }
  return merged;
}

module.exports = { loadConfig };
