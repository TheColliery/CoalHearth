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

// Walk up from cwd for `.coalhearth.json` / `.git`; NEVER walk above home (a config
// above the sandboxed home would leak into a hermetic test — hooks-safety §3, the
// 2026-07-01 lesson also applied in CoalBoard's findProjectCfg).
function findProjectRoot(startDir, home) {
  let dir = path.resolve(startDir);
  const homeAbs = path.resolve(home);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.coalhearth.json'))) return dir;
    if (dir === homeAbs) return startDir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
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
  return merged;
}

module.exports = { loadConfig };
