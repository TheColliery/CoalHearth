#!/usr/bin/env node
// CoalHearth verify gate — fail LOUD if the factory config drifts from the
// schema, required files are missing/malformed, or a lib fails to import.
// Wrapped per-check so one bad input yields a clean FAIL line, not a stack trace.
// Run by the pre-commit / pre-push hooks (scripts-quality.md: CLI = fail loud).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from './lib/config-schema.mjs';
import { stripJsonc } from './lib/jsonc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); fails++; };

console.log('files:');
for (const [label, p] of [
  ['bin/session-start.js', path.join(repo, 'bin', 'session-start.js')],
  ['bin/post-tool-use.js', path.join(repo, 'bin', 'post-tool-use.js')],
  ['lib/handoff-journal.js', path.join(repo, 'lib', 'handoff-journal.js')],
  ['lib/resume-engine.js', path.join(repo, 'lib', 'resume-engine.js')],
  ['lib/budget-tracker.js', path.join(repo, 'lib', 'budget-tracker.js')],
  ['config/schema.json', path.join(repo, 'config', 'schema.json')],
  ['hooks/hooks.json', path.join(repo, 'hooks', 'hooks.json')],
  ['.claude-plugin/plugin.json', path.join(repo, '.claude-plugin', 'plugin.json')],
  ['marketplace.json', path.join(repo, 'marketplace.json')],
  ['.coalhearth.json', path.join(repo, '.coalhearth.json')],
]) { try { fs.existsSync(p) ? ok(label) : fail(`${label} missing`); } catch (e) { fail(`${label}: ${e.message}`); } }

console.log('plugin manifest:');
try {
  const pj = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (pj.name === 'coalhearth') ok("plugin.json name = 'coalhearth'"); else fail(`plugin.json name = '${pj.name}' (want 'coalhearth')`);
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pj.version || '')) ok(`plugin.json version '${pj.version}' is semver`);
  else fail(`plugin.json version '${pj.version}' not semver`);
  const hj = fs.readFileSync(path.join(repo, 'hooks', 'hooks.json'), 'utf8');
  if (hj.includes('${CLAUDE_PLUGIN_ROOT}/bin/session-start.js')) ok('hooks.json wires SessionStart via ${CLAUDE_PLUGIN_ROOT}/bin');
  else fail('hooks.json does not wire SessionStart under ${CLAUDE_PLUGIN_ROOT}/bin');
  if (hj.includes('${CLAUDE_PLUGIN_ROOT}/bin/post-tool-use.js')) ok('hooks.json wires PostToolUse via ${CLAUDE_PLUGIN_ROOT}/bin');
  else fail('hooks.json does not wire PostToolUse under ${CLAUDE_PLUGIN_ROOT}/bin');
} catch (e) { fail(`plugin manifest: ${e.message}`); }

console.log('marketplace.json:');
try {
  const mj = JSON.parse(fs.readFileSync(path.join(repo, 'marketplace.json'), 'utf8'));
  if (mj.plugins?.[0]?.source === './plugin') ok('marketplace.json points at ./plugin');
  else fail(`marketplace.json plugins[0].source = '${mj.plugins?.[0]?.source}' (want './plugin')`);
} catch (e) { fail(`marketplace.json: ${e.message}`); }

console.log('config (factory vs schema):');
try {
  let c = fs.readFileSync(path.join(repo, '.coalhearth.json'), 'utf8');
  if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
  const cfg = JSON.parse(stripJsonc(c));
  const errors = validateConfig(cfg);
  if (!errors.length) ok('factory .coalhearth.json valid against schema');
  else errors.forEach(fail);
} catch (e) { fail(`factory config: ${e.message}`); }

console.log('libs (import check):');
for (const lib of ['config-schema.mjs', 'config-load.mjs', 'jsonc.mjs']) {
  try { await import(pathToFileURL(path.join(repo, 'scripts', 'lib', lib)).href); ok(`${lib} imports`); }
  catch (e) { fail(`${lib}: ${e.message}`); }
}

console.log('plugin/ dist (the clean CC plugin vs source SSoT):');
try {
  const { checkDist } = await import(pathToFileURL(path.join(repo, 'scripts', 'build-plugin.mjs')).href);
  const drift = checkDist();
  if (!drift.length) ok('plugin/ matches source (bin + lib + config + hooks + manifest); nothing else leaked');
  else for (const d of drift) fail(d);
} catch (e) { fail(`plugin/ dist check: ${e.message}`); }

console.log(fails ? `\nVERIFY: FAIL (${fails})` : '\nVERIFY: PASS');
process.exit(fails ? 1 : 0);
