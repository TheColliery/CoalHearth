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

// THE SHIP-TEXT SURFACE SET, declared ONCE and read by BOTH gates below (the config-key
// gate and the pointer gate). Two gates over overlapping surfaces must agree or state why
// they differ; a sibling room shipped two whose sets differed by one unnamed file, so a
// pass line read as ship-text coverage while a tracked ship-text surface went unread.
// Hand-named docs are chosen by name (an unreadable one is a wiring bug); commands/*.md is
// readdir-derived, so a new command is covered the day it lands.
function shipText() {
  const cmdDir = path.join(repo, 'commands');
  const cmdMd = (fs.existsSync(cmdDir) ? fs.readdirSync(cmdDir) : [])
    .filter((f) => f.endsWith('.md')).map((f) => path.join('commands', f));
  const named = ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md',
    path.join('platform-configs', 'hooks', 'README.md')];
  const template = path.join('platform-configs', '.coalhearth.json');
  return { named, template, cmdMd, mdFiles: [...named, ...cmdMd] };
}

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
  const { named, template, cmdMd, mdFiles } = shipText();
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

// pointer drift (CWK-075): every PATH this repo's ship-text points at must resolve to a
// TRACKED file. Three states, not two — tracked is silent, GITIGNORED and existing-but-
// UNTRACKED both FAIL, because from any other machine "gitignored" and "does not exist" are
// indistinguishable and such a citation was never durable.
//
// SURFACE SET: DELIBERATELY IDENTICAL to block 2.9's config-key gate, ~60 lines up. Two
// gates in one file reading the same surfaces is the default; a divergence would need a
// stated reason and there is none. A sibling room shipped two gates whose sets differed by
// one unnamed file — a pass line reading as ship-text coverage while a tracked ship-text
// surface went unread, which is this gate's own class one level up.
console.log('pointer drift:');
try {
  const { checkPointers } = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'pointer-check.mjs')).href);
  const { projectConfigCandidates } = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'config-load.mjs')).href);
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');

  // GIT IS AN OPTIONAL ENHANCEMENT, NEVER A RUNTIME REQUIREMENT (no-external-assumption).
  // This gate's whole question is "reachable from a CLONE", which only git can answer, so
  // without it the honest answer is a NAMED SKIP -- never a FAIL (that would redden a
  // non-git user's gate over a question nobody can ask there) and never a silent pass.
  // Surfaced by this room's own verify.test.mjs, whose sandbox is a plain directory copy
  // with no .git -- the same fixture that caught the config-key gate's scope gap.
  let trackedList = null;
  let gitWhy = '';
  try {
    // stderr is SWALLOWED, not inherited: without this, `fatal: not a git repository` prints
    // above the gate's own line and reads as a crash rather than a degrade (INSPECT LOW-2).
    trackedList = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
  } catch (e) {
    // NAME THE CAUSE THE PROBE ACTUALLY DETERMINED (INSPECT LOW-1). The first wording said
    // "git is unavailable" for both cases; measured in this room's own fixture -- a plain
    // directory copy with git ON PATH -- git was present and the truth was "not a git repo".
    // Keyed on e.code per node/runtime.md 7 (error.code is stable, error.message is not).
    gitWhy = e && e.code === 'ENOENT'
      ? 'git is not installed here'
      : 'this directory is not a git repository';
    trackedList = null;
  }
  if (trackedList === null) {
    console.log(`  --   pointer drift NOT CHECKED: ${gitWhy}, and "reachable from a clone" is a question only git can answer`);
  } else {
  const tracked = new Set(trackedList);
  const trackedDirs = new Set();
  for (const f of tracked) { const p = f.split('/'); for (let i = 1; i < p.length; i++) trackedDirs.add(p.slice(0, i).join('/')); }

  // CONFIG HOMES, DERIVED from this room's own candidate order rather than enumerated, so
  // the set cannot rot the day that order changes.
  const agentHomes = new Set();
  for (const c of projectConfigCandidates(repo, os.homedir())) {
    const r = path.relative(repo, c).split(path.sep).join('/');
    if (!r || r.startsWith('..') || path.isAbsolute(r) || !r.includes('/')) continue;
    const first = r.split('/')[0];
    if (first.startsWith('.') && first.length > 1) agentHomes.add(first);
  }

  // THE FULL TOP-LEVEL ENUMERATION — FILES AND HIDDEN ENTRIES INCLUDED. A dirs-only,
  // non-hidden enumeration is the hazard CWK-078 names, and it is not hypothetical here:
  // this room gitignores six top-level FILES (AGENTS.md, CLAUDE.md, MEMORY.md,
  // COALHEARTH_BLUEPRINT.md, skills-lock.json, skillspector-*.json) and two dot-dirs, so
  // that shape would find NONE of the eight and a citation into one would fall out of scope
  // SILENTLY rather than FAILing — the quieter and worse symptom.
  const topAll = fs.readdirSync(repo, { withFileTypes: true }).map((e) => e.name).filter((n) => n !== '.git');
  const ourRoots = new Set(topAll);
  for (const f of tracked) ourRoots.add(f.split('/')[0]);

  // IGNORED ROOTS: asked of git, never parsed out of .gitignore. Agent homes are excluded
  // BEFORE the question — .claude/ and .agents/ are gitignored here AND are the user-tree
  // paths our shipped prose names, so leaving them in would FAIL a correct citation.
  const ignoredRoots = new Set();
  for (const name of topAll) {
    if (tracked.has(name) || trackedDirs.has(name) || agentHomes.has(name)) continue;
    try { execFileSync('git', ['check-ignore', '-q', '--', name], { cwd: repo }); ignoredRoots.add(name); } catch { /* not ignored */ }
  }

  const readOrNull = (p) => { try { return fs.readFileSync(path.join(repo, p), 'utf8'); } catch { return null; } };
  // ONE constant, not a second hand-kept literal. The "DELIBERATELY IDENTICAL" claim above
  // was true by hand only -- two literals and two readdir calls that agree until someone
  // edits one (INSPECT LOW-3). Now the invariant is structural: both gates read shipText().
  const { mdFiles: ptrMd, template: ptrTemplate } = shipText();
  const labels = [...ptrMd, ptrTemplate].map((l) => l.split(path.sep).join('/'));
  const surfaces = labels.map((l) => ({ label: l, text: readOrNull(l) }));

  // NO historyOnly SURFACE IS PASSED, and the flag is therefore READ BY NOTHING here. That
  // is deliberate: CHANGELOG.md is where this room's history lives and it is out of both
  // gates' surface sets, so a history-only lane would be a name implying a mechanism that
  // does not exist. The parameter stays in the module (an adopter with a history surface
  // needs it); this room simply does not feed one.
  const findings = checkPointers({
    surfaces,
    ourRoots,
    ignoredRoots,
    agentHomes,
    hasEntry: (relDir, name) => { try { return fs.existsSync(path.join(repo, relDir, name)); } catch { return false; } },
    resolve: (p) => (tracked.has(p) || trackedDirs.has(p) ? 'tracked'
      : fs.existsSync(path.join(repo, p)) ? 'untracked' : 'missing'),
  });

  // PRINT the derived enumeration. A set that comes back wrong (or empty) is exactly the
  // failure this room was warned about, and it is invisible unless it is shown.
  console.log(`  --   top-level entries fed to git check-ignore: ${topAll.length} (files + hidden included) — ${ignoredRoots.size} gitignored, ${agentHomes.size} agent home(s): ${[...agentHomes].sort().join(' ')}`);
  const hardP = findings.filter((f) => f.level !== 'SKIP');
  for (const f of findings) {
    if (f.level === 'SKIP') console.log('  --   ' + f.msg);
    else fail(f.msg);
  }
  if (!hardP.length) ok(`every path this repo points at from ${surfaces.length} ship-text surface(s) (${findings.checked} in-scope citations) resolves to a TRACKED file — sections and symbols are NOT checked, see scripts/lib/pointer-check.mjs`);
  }
} catch (e) { fail(`pointer drift check crashed: ${e.message}`); }

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
