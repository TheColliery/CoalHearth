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

// Walk up from startDir looking for `.coalhearth.json` or `.git` (project root
// marker); NEVER walk above `home` — stop there and fall back to startDir.
export function findProjectRoot(startDir = process.cwd(), home = os.homedir()) {
  let dir = path.resolve(startDir);
  const homeAbs = path.resolve(home);
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

// Shallow-per-group merge: project group overwrites global group key-by-key.
export function loadMergedConfig({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const global = readJsonc(globalConfigPath(home));
  const project = readJsonc(projectConfigPath(cwd, home));
  const merged = {};
  for (const group of new Set([...Object.keys(global), ...Object.keys(project)])) {
    merged[group] = { ...(global[group] || {}), ...(project[group] || {}) };
  }
  return merged;
}
