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
  ['config/schema.json', path.join(repo, 'config', 'schema.json')],
  ['hooks/hooks.json', path.join(repo, 'hooks', 'hooks.json')],
  ['commands/update.md', path.join(repo, 'commands', 'update.md')],
  ['.claude-plugin/plugin.json', path.join(repo, '.claude-plugin', 'plugin.json')],
  ['.claude-plugin/marketplace.json', path.join(repo, '.claude-plugin', 'marketplace.json')],
  ['platform-configs/.coalhearth.json', path.join(repo, 'platform-configs', '.coalhearth.json')],
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
  if (hj.includes('${CLAUDE_PLUGIN_ROOT}/bin/user-prompt-submit.js')) ok('hooks.json wires UserPromptSubmit via ${CLAUDE_PLUGIN_ROOT}/bin');
  else fail('hooks.json does not wire UserPromptSubmit under ${CLAUDE_PLUGIN_ROOT}/bin');
} catch (e) { fail(`plugin manifest: ${e.message}`); }

console.log('marketplace.json:');
try {
  const mj = JSON.parse(fs.readFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), 'utf8'));
  if (mj.plugins?.[0]?.source === './plugin') ok('marketplace.json points at ./plugin');
  else fail(`marketplace.json plugins[0].source = '${mj.plugins?.[0]?.source}' (want './plugin')`);
} catch (e) { fail(`marketplace.json: ${e.message}`); }

console.log('description length cap (skills + commands):');
// Skill-listing description cap: gate at 1024 = cross-platform-safe (agentskills.io / agnix);
// CC's own listing truncation is 1536 chars combined description+when_to_use
// (code.claude.com/docs/en/skills, verified 2026-07-16). USER standard 2026-07-16: never exceed.
const DESC_CAP = 1024;
function frontmatterField(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(key + ':'));
  if (i === -1) return null;
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(v)) {
    const parts = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) parts.push(lines[j].trim());
    return parts.join(' ');
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}
// Dynamic scan (skills/*/SKILL.md for any dir that has one, commands/*.md) so a
// new skill/command is covered without editing this gate. CoalHearth ships no
// skills/ today (commands/ only) — the skills half is a no-op until one exists.
const descTargets = [];
const skillsDir = path.join(repo, 'skills');
if (fs.existsSync(skillsDir)) {
  for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const smd = path.join(skillsDir, d.name, 'SKILL.md');
    if (fs.existsSync(smd)) descTargets.push([`skills/${d.name}/SKILL.md`, smd, true]);
  }
}
const commandsDir = path.join(repo, 'commands');
if (fs.existsSync(commandsDir)) {
  for (const f of fs.readdirSync(commandsDir)) {
    if (f.endsWith('.md')) descTargets.push([`commands/${f}`, path.join(commandsDir, f), false]);
  }
}
for (const [label, p, isSkill] of descTargets) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const len = (frontmatterField(text, 'description') || '').length + (frontmatterField(text, 'when_to_use') || '').length;
    if (isSkill && len === 0) fail(`${label}: frontmatter description missing/unparsed`);
    else if (len > DESC_CAP) fail(`${label}: description+when_to_use ${len} chars exceeds the ${DESC_CAP}-char cap`);
    else ok(`${label}: ${len} chars (cap ${DESC_CAP})`);
  } catch (e) { fail(`${label} description check: ${e.message}`); }
}

console.log('plugin.json own description:');
// board #64: the description-cap gate above (skills/*/SKILL.md + commands/*.md
// frontmatter) never read .claude-plugin/plugin.json's OWN description field — the
// string a marketplace/plugin listing actually renders. CoalLedger shipped one at
// 1067 chars, over the 1024 cap, and only a human eye caught it. plugin.json is plain
// JSON, not YAML frontmatter, so this reads the field directly rather than through
// frontmatterField; DESC_CAP is the SAME constant declared above, never redefined.
// BOM-strip matches this file's OWN existing idiom (charCodeAt(0)===0xFEFF, used twice
// already at the config-schema and version-pin checks below) rather than introducing a
// second BOM-strip shape into one file -- a deliberate, named divergence from the
// exemplar's separate BOM_RE regex constant.
{
  const pluginJsonPath = path.join(repo, '.claude-plugin', 'plugin.json');
  try {
    let raw = fs.readFileSync(pluginJsonPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const d = JSON.parse(raw).description;
    // A truthy NON-STRING description (123, {}, ['a']) must fail loud, not silently
    // read as 0 chars and pass -- the exact hole a CoalBoard sibling found in the
    // shipped exemplar's `typeof===string?len:0` shape (0 > DESC_CAP is always false).
    if (d === undefined || d === null || d === '') fail('.claude-plugin/plugin.json: description missing');
    else if (typeof d !== 'string') fail(`.claude-plugin/plugin.json: description is not a string (got ${typeof d})`);
    else if (d.length > DESC_CAP) fail(`.claude-plugin/plugin.json: description ${d.length} chars exceeds the ${DESC_CAP}-char cap`);
    else ok(`.claude-plugin/plugin.json: ${d.length} chars (cap ${DESC_CAP})`);
  } catch (e) { fail(`.claude-plugin/plugin.json description check: ${e.message}`); }
}

console.log('config (factory vs schema):');
try {
  let c = fs.readFileSync(path.join(repo, 'platform-configs', '.coalhearth.json'), 'utf8');
  if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
  const cfg = JSON.parse(stripJsonc(c));
  const errors = validateConfig(cfg);
  if (!errors.length) ok('factory .coalhearth.json valid against schema');
  else errors.forEach(fail);
} catch (e) { fail(`factory config: ${e.message}`); }

// config-key drift (CWK-060): every config key NAMED on a user-facing surface must RESOLVE
// in config-schema.mjs, or be declared. Born from a flock class — four sibling rooms shipped
// ship-text naming a key their schema did not carry, invisible to every gate any of us had.
//
// SCOPE DERIVATION, stated rather than implied (AGENTS.md, THE MEASUREMENT'S OWN FOURTH
// TENSE). WALKED, so a new file is covered the day it lands: commands/*.md (readdir). CHOSEN
// by decision, so a new one is NOT covered until someone adds it here: the five root/shipped
// docs and the config template. What is deliberately NOT reached, and why, is enumerated in
// config-keys.mjs's own surface list with the measurement behind each exclusion. A clean run
// is coverage of THOSE surfaces only — never of every surface this room ships.
console.log('config keys:');
try {
  const { checkConfigKeys } = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'config-keys.mjs')).href);
  const { CONFIG_SCHEMA } = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'config-schema.mjs')).href);
  // NAME the intended surfaces; let the checker report what it could not read. A caller that
  // existsSync-filters first hides its own scope gap — the silent narrowing this gate exists
  // to catch, committed by the gate's own wiring.
  const cmdDir = path.join(repo, 'commands');
  const cmdMd = (fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir) : [])
    .filter((f) => f.endsWith('.md')).map((f) => path.join('commands', f));
  const named = ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md',
    path.join('platform-configs', 'hooks', 'README.md')];
  const template = path.join('platform-configs', '.coalhearth.json');
  const mdFiles = [...named, ...cmdMd];
  const { findings, coverage } = checkConfigKeys({
    schema: CONFIG_SCHEMA,
    mdFiles,
    // Hand-named surfaces FAIL when unreadable; `cmdMd` is readdir-derived and cannot go
    // stale, so it is deliberately absent from this list.
    namedSurfaces: [...named, template],
    templateFiles: [template],
    keyTables: [{ file: 'README.md', heading: 'Configure' }],
    read: (f) => fs.readFileSync(path.join(repo, f), 'utf8'),
  });
  // PER-LOCATOR COVERAGE EVERY RUN — a number a reader can sanity-check against the files is
  // the only defence against a locator that silently found nothing and reported clean.
  console.log('  --   coverage: ' + coverage);
  const hard = findings.filter((f) => f.level !== 'SKIP');
  for (const f of findings) {
    if (f.level === 'SKIP') console.log('  --   ' + f.msg);
    else fail(f.msg);
  }
  // The pass line is QUALIFIED when the gate has declared blind spots: an unqualified "every
  // config key resolves" would be false while a declared key is read and discarded.
  const blindSkips = findings.filter((f) => f.level === 'SKIP' && f.msg.startsWith('blind to'));
  const scope = blindSkips.length ? 'every REACHABLE config key' : 'every config key';
  if (hard.length === 0) ok(`${scope} named across ${mdFiles.length} doc + 1 template surface resolves in the schema`);
} catch (e) { fail(`config-key drift check crashed: ${e.message}`); }

console.log('libs (import check):');
for (const lib of ['config-schema.mjs', 'config-load.mjs', 'jsonc.mjs']) {
  try { await import(pathToFileURL(path.join(repo, 'scripts', 'lib', lib)).href); ok(`${lib} imports`); }
  catch (e) { fail(`${lib}: ${e.message}`); }
}

console.log('plugin/ dist (the clean CC plugin vs source SSoT):');
try {
  const { checkDist } = await import(pathToFileURL(path.join(repo, 'scripts', 'build-plugin.mjs')).href);
  const drift = checkDist();
  if (!drift.length) ok('plugin/ matches source (bin + lib + config + hooks + commands + manifest); nothing else leaked');
  else for (const d of drift) fail(d);
} catch (e) { fail(`plugin/ dist check: ${e.message}`); }

console.log('version pins (.github/ISSUE_TEMPLATE):');
// Mirrors CoalMine's checkVersionPins (scripts-quality.md doc-transition gate): any
// issue-template line carrying a `version-pin:` marker must quote the CURRENT
// plugin.json version. The regex accepts a pre-release suffix — a strict x.y.z once
// rejected a beta tag at release time (SKILL-REPO-PATTERN Layer 4).
try {
  let pjRaw = fs.readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8');
  if (pjRaw.charCodeAt(0) === 0xFEFF) pjRaw = pjRaw.slice(1);
  const version = JSON.parse(pjRaw).version;
  const tplDir = path.join(repo, '.github', 'ISSUE_TEMPLATE');
  let pins = 0;
  for (const name of fs.readdirSync(tplDir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = fs.readFileSync(path.join(tplDir, name), 'utf8').replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('version-pin:')) return;
      pins++;
      const m = line.match(/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      if (!m) fail(`${name}:${i + 1} is marked version-pin but has no vX.Y.Z to check`);
      else if (m[1] !== version) fail(`${name}:${i + 1} pins v${m[1]} but plugin.json is v${version} — bump the pin`);
      else ok(`${name}:${i + 1} pin matches v${version}`);
    });
  }
  if (!pins) fail('no version-pin marker found in .github/ISSUE_TEMPLATE (the bug-report placeholder must carry one)');
} catch (e) { fail(`version pins: ${e.message}`); }

console.log(fails ? `\nVERIFY: FAIL (${fails})` : '\nVERIFY: PASS');
process.exit(fails ? 1 : 0);
