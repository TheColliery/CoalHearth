import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, projectConfigPath, loadMergedConfig } from './config-load.mjs';
import * as twin from './config-load.mjs'; // UMB-133: namespace import so a missing export fails PER TEST, not at link time
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// CWK-120 finding #6 (CodeRabbit, Minor), verified at the live tree: the global config path honours
// CLAUDE_CONFIG_DIR BEFORE the `home` argument, and nothing here cleared it -- on a machine (or CI image) that sets it,
// the "global" tier resolved OUTSIDE the sandbox home and 25 cases read a foreign .coalhearth.json and failed.
// Cleared once per file: each node --test file runs in its own process, so this cannot leak into another suite.
delete process.env.CLAUDE_CONFIG_DIR;

function mkSandboxHome() {
  // realpath the sandbox: findProjectRoot compares PHYSICAL paths (macOS tmpdir is a
  // /var -> /private/var symlink), so the test's dirs must be physical to agree on every OS.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-test-')));
}

test('findProjectRoot stops at home and never walks above it', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const deep = path.join(home, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  const root = findProjectRoot(deep, home);
  assert.equal(path.resolve(root), path.resolve(deep)); // no .git/.coalhearth.json found -> falls back to startDir
});

test('findProjectRoot finds a .coalhearth.json marker above cwd but below home', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, 'proj');
  const deep = path.join(projectDir, 'src', 'nested');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), '{}');
  const root = findProjectRoot(deep, home);
  assert.equal(path.resolve(root), path.resolve(projectDir));
});

test('loadMergedConfig merges project over global per group, never throws on missing files', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 5 } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 3 } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.journal.atomicityRetries, 3); // project wins
  assert.equal(merged.journal.outputDirectory, '.claude/coalhearth'); // global key survives shallow merge
});

test('loadMergedConfig returns {} when neither file exists (never throws)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'empty');
  fs.mkdirSync(cwd, { recursive: true });
  assert.deepEqual(loadMergedConfig({ cwd, home }), {});
});

// AL-2 -- mirrors lib/load-config.test.js's identical cases 1:1 (this file's own header
// comment). `language` is a top-level SCALAR, not a group -- spreading a string as though
// it were an object would explode it into indexed characters ({0:'a',1:'u',...}).
test('AL-2: a top-level scalar (language) is NOT spread -- project wins outright, no per-key merge', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'en' }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.language, 'th', 'project scalar wins outright, and is not exploded into an object');
});

test('AL-2: a scalar set only globally falls back correctly when the project never touches it', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'ja' }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 2 } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.language, 'ja', 'global scalar survives when the project config never sets the key');
  assert.equal(merged.journal.atomicityRetries, 2, 'a real GROUP alongside the scalar still merges per-key, unaffected');
});

test('AL-2: a scalar set only by the project (no global at all) survives -- and a real group merge is unaffected', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ language: 'zh', recovery: { stashUnsavedChanges: false } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.language, 'zh');
  assert.equal(merged.recovery.stashUnsavedChanges, false, 'a real GROUP with no global counterpart still merges to a fresh object');
});

// r29 findings-back LOW 3 (mirrored 1:1 from lib/load-config.test.js) -- a MIXED tier (one
// side a group, the other a present scalar) used to run the group-merge branch regardless
// and silently discard whichever side was not object-shaped.
test('AL-2 LOW-3: project scalar wins over global group-garbage (mixed tier, project-wins preserved)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: { a: 1 } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.language, 'th', 'a present project scalar wins outright over a global object, mixed-shape or not');
});

test('AL-2 LOW-3: a mixed-shape project value still wins outright over a global scalar', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ language: {} }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.deepEqual(merged.language, {}, 'a present project value (however wrong-shaped) still wins outright -- resolving that is validateConfig\'s job, not the merge\'s');
});

// hooks-safety.md §9 (config-cascade clamp): mirrors lib/load-config.js's clamp test
// 1:1. RED-PROOF: revert loadMergedConfig's updateMode post-clamp and this goes red.
test('consent-cascade clamp: a project cannot re-escalate a user-silenced updateMode (hooks-safety.md §9)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.update.updateMode, 'off', 'a project must not turn a user-silenced update nudge back on');
});

test('consent-cascade clamp: a project MAY still quieten updateMode below global', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.update.updateMode, 'off', 'quietening still works');
});

// R2/R3 (hooks-safety.md §9 amendment, 2026-07-27) — mirrors lib/load-config.test.js
// 1:1. See that file for the full RED-PROOF rationale.
test('R2 factory-default: NO global config at all still clamps project updateMode to the schema default (ask)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const merged = loadMergedConfig({ cwd: projectDir, home }); // no ~/.claude/.coalhearth.json at all
  assert.equal(merged.update.updateMode, 'ask', 'an absent global is the schema default (ask), not a clamp skip');
});

test('R3 consent-cascade clamp: a project cannot re-escalate a user-silenced autoInjectPrompt', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: false } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: true } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.recovery.autoInjectPrompt, false, 'a project must not turn a user-silenced recovery injection back on');
});

test('R3: stashUnsavedChanges stays plain project-wins, unclamped (correctly out of scope)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ recovery: { stashUnsavedChanges: false } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ recovery: { stashUnsavedChanges: true } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.recovery.stashUnsavedChanges, true, 'an advisory-only key is plain project-wins, no clamp');
});

// Namespace campaign (#69+#39): when nothing exists anywhere, projectConfigPath's
// default write target is now the own-dir (or `.claude`-first) candidate, not the
// bare legacy dotfile -- this assertion changed to match the ruling, per the room's
// own "fix the test, don't patch the code to keep it green" discipline (the code is
// right; the OLD assertion encoded the pre-campaign default).
test('projectConfigPath composes an own-dir/coal/ default when nothing exists anywhere', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const p = projectConfigPath(home, home);
  assert.equal(path.basename(p), 'coalhearth.json');
  assert.equal(path.basename(path.dirname(p)), 'coal');
  assert.equal(path.basename(path.dirname(path.dirname(p))), '.claude');
});

test('loadMergedConfig is prototype-pollution safe (a poisoned project config cannot touch Object.prototype)', (t) => {
  const home = mkSandboxHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  // A poisoned project .coalhearth.json (as an untrusted cloned repo might ship): a
  // TOP-LEVEL __proto__ group (unguarded -> merged['__proto__']=... [[Set]] pollution) and
  // a NESTED one inside a real group.
  fs.writeFileSync(
    path.join(projectDir, '.coalhearth.json'),
    '{ "__proto__": { "polluted": true }, "journal": { "__proto__": { "polluted2": true }, "atomicityRetries": 5 } }'
  );
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal({}.polluted, undefined, 'Object.prototype NOT polluted (top-level __proto__)');
  assert.equal({}.polluted2, undefined, 'Object.prototype NOT polluted (nested __proto__)');
  assert.equal(merged.journal.atomicityRetries, 5, 'legit keys still load past the guard');
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), false, '__proto__ dropped from the merged config');
});

// --- Namespace campaign (#69+#39, owner-designated 2026-08-08), mirrors lib/load-config.test.js ---

test('namespace campaign: own-dir wins over other agent dirs and the legacy root file', (t) => {
  const root = mkSandboxHome();
  const home = mkSandboxHome();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.claude', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 1 } }));
  fs.mkdirSync(path.join(root, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 2 } }));
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 3 } }));
  const merged = loadMergedConfig({ cwd: root, home, ownDir: '.agents' });
  assert.equal(merged.journal.atomicityRetries, 2, 'the running agent reads ITS OWN dir first, ahead of .claude and legacy');
});

test('namespace campaign: another known agent dir is found (first-found-wins) when own-dir has nothing', (t) => {
  const root = mkSandboxHome();
  const home = mkSandboxHome();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.gemini', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gemini', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 7 } }));
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 9 } }));
  const merged = loadMergedConfig({ cwd: root, home, ownDir: '.claude' }); // own dir (.claude) has nothing
  assert.equal(merged.journal.atomicityRetries, 7, '.gemini is found via the fixed fallback order, ahead of the legacy root file');
});

test('namespace campaign: legacy root dotfile is read when no agent-dir candidate exists anywhere', (t) => {
  const root = mkSandboxHome();
  const home = mkSandboxHome();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 11 } }));
  const merged = loadMergedConfig({ cwd: root, home, ownDir: '.agents' });
  assert.equal(merged.journal.atomicityRetries, 11, 'the legacy shape is still read normally -- no breakage for an existing user');
});

// Root-marker widening (item 1): a project configured ONLY through the new shape (no
// .git, no legacy dotfile) must still anchor correctly, not fall through to startDir.
test('namespace campaign: findProjectRoot anchors on a NEW-shape marker alone (no .git, no legacy dotfile)', (t) => {
  const root = mkSandboxHome();
  const home = mkSandboxHome();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 42 } }));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const found = findProjectRoot(sub, home);
  assert.equal(path.resolve(found), path.resolve(root), 'walking up from a subdir must anchor on the new-shape-only root');
  const merged = loadMergedConfig({ cwd: sub, home, ownDir: '.agents' });
  assert.equal(merged.journal.atomicityRetries, 42);
});

// Additive-only proof: widening ROOT_MARKERS must never make the walk skip a NEARER
// root to reach a farther one -- it can only make the walk stop LOWER (nearer), never
// wider. A nested project (root/sub, itself a root via a new-shape marker) must still
// win over the outer root (an old-shape .git) when walking from inside sub.
test('namespace campaign: root-marker widening never widens the walk -- the NEARER root still wins', (t) => {
  const outer = mkSandboxHome();
  const home = mkSandboxHome();
  t.after(() => {
    fs.rmSync(outer, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outer, '.git'), ''); // old-shape marker at the OUTER root
  fs.writeFileSync(path.join(outer, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 100 } }));
  const inner = path.join(outer, 'sub');
  fs.mkdirSync(path.join(inner, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(inner, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 200 } })); // new-shape marker, NEARER
  const deep = path.join(inner, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  const found = findProjectRoot(deep, home);
  assert.equal(path.resolve(found), path.resolve(inner), 'the walk stops at the NEARER root (inner), never skips past it to the farther outer one');
});

// Clamp-unchanged regression (item 4): the safer-value-wins semantics must not depend
// on WHICH candidate address supplied the project value -- only the file's ADDRESS
// moved, never the cascade rule.
test('namespace campaign: the consent-cascade clamp is unchanged regardless of WHICH candidate supplied the project value', (t) => {
  const home = mkSandboxHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const root = mkSandboxHome();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.gemini', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gemini', 'coal', 'coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const merged = loadMergedConfig({ cwd: root, home, ownDir: '.gemini' });
  assert.equal(merged.update.updateMode, 'off', 'a project value found at a NEW-shape candidate is clamped exactly like the legacy shape was');
});

// ---------------------------------------------------------------------------------------
// UMB-133 (config-path unification) -- mirrors lib/load-config.test.js case-for-case, plus
// the TWIN-AGREEMENT table at the bottom (the two loaders are hand-mirrored; nothing else
// keeps them honest about each other). Each temp dir is registered for cleanup on the line
// after it is allocated (scripts-quality.md 2).
// ---------------------------------------------------------------------------------------
const { configNotices, projectConfigCandidates } = twin;
const requireCjs = createRequire(import.meta.url);
const cjs = requireCjs('../../lib/load-config.js');

function mkT(t) {
  const d = mkSandboxHome();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function put(dir, rel, obj) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
function project(t) {
  const root = mkT(t);
  fs.mkdirSync(path.join(root, '.git'));
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  return { root, sub };
}
const NESTED = path.join('.claude', '.coalhearth.json');
const CANON_TAIL = 'canonical = .claude/coal/coalhearth.json';

test('UMB-133 proof 1: <root>/.claude/.coalhearth.json (nested legacy) is FOUND', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, NESTED, { journal: { atomicityRetries: 7 } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 7);
});

test('UMB-133 proof 2: <root>/.coalhearth.json (root legacy) is still found', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, '.coalhearth.json', { journal: { atomicityRetries: 8 } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 8);
});

test('UMB-133 proof 3: canonical wins over BOTH legacies, and nested legacy wins over root legacy', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 1 } });
  const nested = put(root, NESTED, { journal: { atomicityRetries: 2 } });
  put(root, '.coalhearth.json', { journal: { atomicityRetries: 3 } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 1, 'canonical first');
  fs.rmSync(canon);
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 2, 'nested legacy before root legacy');
  fs.rmSync(nested);
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 3, 'root legacy last');
});

test('UMB-133 proof 4: a config at a NON-candidate path is REPORTED, never silently walked past', (t) => {
  const shapes = [
    path.join('.agents', '.coalhearth.json'),
    path.join('.gemini', '.coalhearth.json'),
    path.join('.claude', 'coalhearth.json'),
    path.join('.claude', 'coal', '.coalhearth.json'),
    path.join('.agents', 'coalhearth.json'),
    'coalhearth.json',
    path.join('coal', 'coalhearth.json'),
  ];
  for (const rel of shapes) {
    const { root, sub } = project(t);
    const home = mkT(t);
    const f = put(root, rel, { journal: { atomicityRetries: 9 } });
    assert.deepEqual(
      configNotices({ cwd: sub, home }),
      ['IGNORED: ' + f + ' is not a config path; ' + CANON_TAIL],
      rel + ' must be reported exactly once'
    );
    assert.equal(loadMergedConfig({ cwd: sub, home }).journal, undefined, rel + ' is still NOT read (report, never adopt)');
  }
});

test('UMB-133 proof 4b: the probe is a CLOSED set at the walk\'s own root, not a filesystem crawl', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  // (a stray `coalhearth.json` -- NOT `.coalhearth.json`, which below the root would itself BE the root)
  put(sub, 'coalhearth.json', {});
  put(root, path.join('other', '.coalhearth.json'), {});
  put(root, path.join('.claude', 'deep', 'coalhearth.json'), {});
  assert.deepEqual(configNotices({ cwd: sub, home }), []);
});

test('UMB-133 proof 5: a legacy hit emits ONE line naming the canonical path (both legacy shapes)', (t) => {
  for (const rel of [NESTED, '.coalhearth.json']) {
    const { root, sub } = project(t);
    const home = mkT(t);
    const f = put(root, rel, { journal: { atomicityRetries: 5 } });
    const lines = configNotices({ cwd: sub, home });
    assert.equal(lines.length, 1, rel + ': exactly one line');
    assert.ok(lines[0].includes(f), 'names the legacy file it read');
    assert.ok(lines[0].includes(CANON_TAIL), 'names the canonical path');
    assert.ok(!lines[0].includes('\n'), 'one line');
  }
});

test('UMB-133: a canonical config, or none at all, emits no notice', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  assert.deepEqual(configNotices({ cwd: sub, home }), []);
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 1 } });
  assert.deepEqual(configNotices({ cwd: sub, home }), []);
});

test('UMB-133: configNotices never throws (a cwd that does not exist)', (t) => {
  const home = mkT(t);
  assert.doesNotThrow(() => configNotices({ cwd: path.join(home, 'no', 'such', 'dir'), home }));
});

test('UMB-133 clamp: a config found at the NESTED legacy path is still clamped safer-value-wins', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { update: { updateMode: 'off' }, recovery: { autoInjectPrompt: false } });
  put(root, NESTED, { update: { updateMode: 'auto' }, recovery: { autoInjectPrompt: true } });
  const cfg = loadMergedConfig({ cwd: sub, home });
  assert.equal(cfg.update.updateMode, 'off', 'a project may not re-escalate a user-silenced nudge');
  assert.equal(cfg.recovery.autoInjectPrompt, false, 'a project may not re-enable a user-silenced injection');
});

test('UMB-133 clamp: R2 factory-default still applies to a nested-legacy project with NO global', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, NESTED, { update: { updateMode: 'auto' } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).update.updateMode, 'ask');
});

test('UMB-133 ROOT_MARKERS ruling: the global config never anchors a root or reads as a project legacy', (t) => {
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { journal: { atomicityRetries: 4 } });
  const proj = path.join(home, 'proj', 'src');
  fs.mkdirSync(proj, { recursive: true });
  assert.equal(findProjectRoot(proj, home), proj, 'no marker of ours between here and home -> startDir, not home');
  assert.deepEqual(configNotices({ cwd: proj, home }), []);
  assert.deepEqual(configNotices({ cwd: home, home }), []);
  assert.equal(loadMergedConfig({ cwd: home, home }).journal.atomicityRetries, 4);
});

// TWIN AGREEMENT. lib/load-config.js (CJS, ships) and scripts/lib/config-load.mjs (ESM,
// tooling) are hand-mirrored -- the AL-2 scalar-merge bug lived in BOTH. This table runs one
// set of on-disk fixtures through both and asserts they agree on every observable: the
// candidate order, the path chosen, the notices, and the merged config. A change made to
// one twin only turns a row red here.
const NEST_CANON = path.join('.claude', 'coal', 'coalhearth.json');
const TWIN_FIXTURES = [
  { name: 'nothing anywhere', files: {} },
  { name: 'canonical only', files: { [NEST_CANON]: { journal: { atomicityRetries: 1 } } } },
  { name: 'nested legacy only', files: { [NESTED]: { journal: { atomicityRetries: 2 } } } },
  { name: 'root legacy only', files: { '.coalhearth.json': { journal: { atomicityRetries: 3 } } } },
  { name: 'all three', files: { [NEST_CANON]: { journal: { atomicityRetries: 1 } }, [NESTED]: { journal: { atomicityRetries: 2 } }, '.coalhearth.json': { journal: { atomicityRetries: 3 } } } },
  { name: 'nested beats root', files: { [NESTED]: { journal: { atomicityRetries: 2 } }, '.coalhearth.json': { journal: { atomicityRetries: 3 } } } },
  { name: 'ownDir .agents hoisted', ownDir: '.agents', files: { [NEST_CANON]: { journal: { atomicityRetries: 1 } }, [path.join('.agents', 'coal', 'coalhearth.json')]: { journal: { atomicityRetries: 6 } } } },
  { name: 'ownDir .gemini, legacy fallback', ownDir: '.gemini', files: { [NESTED]: { journal: { atomicityRetries: 2 } } } },
  { name: 'misplaced shapes', files: { [path.join('.agents', '.coalhearth.json')]: {}, [path.join('.claude', 'coalhearth.json')]: {}, 'coalhearth.json': {}, [path.join('.claude', 'coal', '.coalhearth.json')]: {} } },
  { name: 'misplaced + legacy hit', files: { [NESTED]: { update: { updateMode: 'auto' } }, [path.join('.gemini', 'coalhearth.json')]: {} } },
  { name: 'unrecognised ownDir falls back to .claude-first', ownDir: '.nope', files: { [NEST_CANON]: { journal: { atomicityRetries: 1 } } } },
  { name: 'CWK-127 a directory at the nested legacy path', dirs: [NESTED], files: { '.coalhearth.json': { journal: { atomicityRetries: 3 } } } },
  { name: 'CWK-127 a directory at the canonical path', dirs: [NEST_CANON], files: { [NESTED]: { journal: { atomicityRetries: 2 } } } },
];

for (const fx of TWIN_FIXTURES) {
  test('UMB-133 twin agreement: ' + fx.name, (t) => {
    const { root, sub } = project(t);
    const home = mkT(t);
    put(home, path.join('.claude', '.coalhearth.json'), { update: { updateMode: 'ask' } });
    for (const d of fx.dirs || []) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const [rel, obj] of Object.entries(fx.files)) put(root, rel, obj);
    const opts = { cwd: sub, home, ownDir: fx.ownDir };
    assert.deepEqual(cjs.projectConfigCandidates(sub, home, fx.ownDir), projectConfigCandidates(sub, home, fx.ownDir), 'candidate order');
    assert.equal(cjs.projectConfigPath(sub, home, fx.ownDir), projectConfigPath(sub, home, fx.ownDir), 'path chosen');
    assert.deepEqual(cjs.configNotices(opts), configNotices(opts), 'notices');
    assert.deepEqual(cjs.loadConfig(opts), loadMergedConfig(opts), 'merged config');
  });
}

test('UMB-133 twin agreement: cwd AT home (the global-collision guard) agrees too', (t) => {
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { journal: { atomicityRetries: 4 } });
  assert.deepEqual(cjs.projectConfigCandidates(home, home), projectConfigCandidates(home, home));
  assert.equal(cjs.projectConfigPath(home, home), projectConfigPath(home, home));
  assert.deepEqual(cjs.configNotices({ cwd: home, home }), configNotices({ cwd: home, home }));
  assert.deepEqual(cjs.loadConfig({ cwd: home, home }), loadMergedConfig({ cwd: home, home }));
});

// CWK-127 (INSPECT L2, deferred at UMB-133): the walk SELECTED a candidate on existsSync while the
// IGNORED probe used isFile, so a DIRECTORY at a candidate path won the walk, read as {}, and
// SHADOWED the real config beneath it -- and the LEGACY line then claimed the directory was
// "still read". isFile now guards every config-path site; a directory is not a config. `.git` is
// the one deliberate exception (a worktree's .git is a FILE, a normal one a directory -- either
// anchors). Exemplar for the class: CoalLedger 0998432.
test('CWK-127: a DIRECTORY at the nested-legacy path never shadows the real root-legacy config', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(root, NESTED), { recursive: true }); // a directory named like a config file
  const real = put(root, '.coalhearth.json', { journal: { atomicityRetries: 7 } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 7, 'the real config is READ, not shadowed by the directory');
  assert.equal(projectConfigPath(sub, home), real);
  const lines = configNotices({ cwd: sub, home });
  assert.ok(lines.some((l) => l.startsWith('LEGACY: ' + real)), 'the LEGACY line names the file actually read: ' + JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.startsWith('LEGACY: ' + path.join(root, NESTED))), 'and never claims the directory is "still read"');
});

test('CWK-127: a DIRECTORY at a CANONICAL path never shadows a real legacy config either', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(root, '.claude', 'coal', 'coalhearth.json'), { recursive: true });
  const real = put(root, NESTED, { journal: { atomicityRetries: 8 } });
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 8);
  assert.equal(projectConfigPath(sub, home), real);
});

test('CWK-127: a directory named like a config MARKER does not anchor the walk (a marker must be a file)', (t) => {
  const home = mkT(t);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.coalhearth.json'), { recursive: true }); // a directory, not a config
  const sub = path.join(proj, 'src');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findProjectRoot(sub, home), sub, 'no real marker between here and home -> startDir');
  fs.mkdirSync(path.join(proj, '.git')); // .git is the exception: a directory anchors
  assert.equal(findProjectRoot(sub, home), proj);
});

// -- UMB-174 (b): the ONE flock string for a config that is PRESENT but UNREADABLE --------------
// A config that exists at a path the walk reads but cannot be turned into a config used to be
// skipped in SILENCE -- the same "silence reads as honoured" class UMB-133 closed for the wrong
// PATH. Now, on SessionStart only (configNotices; never a crawl, only paths the walk already
// stats), each is named with its reason:
//   UNREADABLE: <path> exists but is not a readable config (<reason>); it was skipped \u2014 canonical = <canonical>
// <reason> is one of: malformed JSON | a directory | unreadable (BOTH EACCES and EPERM -- a Windows
// ACL denial surfaces as EPERM) | not a JSON object (valid JSON that is not a plain object). The
// SELECTION is unchanged (an unreadable candidate still wins the walk and contributes {}); only the
// silence goes. Exemplar: CoalFace v0.12.0; the fourth reason is main's C-5 ruling, CoalTipple's.
// Every case runs BOTH twins (the CJS hook copy that ships and the ESM tooling copy).
const CJS_ESM = [['esm', twin], ['cjs', cjs]];
const unreadableLine = (p, reason, canon = CANON_REL) => 'UNREADABLE: ' + p + ' exists but is not a readable config (' + reason + '); it was skipped \u2014 canonical = ' + canon;
const CANON_REL = '.claude/coal/coalhearth.json';
function hermetic(t) { // the global path honours CLAUDE_CONFIG_DIR before the sandbox home
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
}
const unreadableOf = (api, opts) => api.configNotices(opts).filter((l) => l.startsWith('UNREADABLE:'));

test('UMB-174 (b) reason "malformed JSON": a canonical project config that does not parse is REPORTED, and still wins the walk', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = path.join(root, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(path.dirname(canon), { recursive: true });
  fs.writeFileSync(canon, '{ this is not json');
  put(root, '.coalhearth.json', { journal: { atomicityRetries: 9 } }); // a real config BELOW it
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(canon, 'malformed JSON')], name);
  }
  // SELECTION unchanged: the unreadable candidate still wins and contributes {}, exactly as before.
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal, undefined, 'the unreadable canonical still shadows the legacy one beneath it');
});

test('UMB-174 (b) reason "a directory": a directory the walk stepped over is REPORTED', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const dir = path.join(root, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(dir, { recursive: true });
  put(root, NESTED, { journal: { atomicityRetries: 8 } });
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(dir, 'a directory')], name);
  }
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 8, 'selection: the real file beneath is read (CWK-127)');
});

test('UMB-174 (b) reason "a directory": nothing found anywhere -> every directory the walk passed is named', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const dir = path.join(root, '.coalhearth.json');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(dir, 'a directory')], name);
  }
});

// Denying a read is platform-specific: POSIX mode bits, or on NTFS an ACL (libuv reports it as EPERM,
// not EACCES). Capability-PROBED, never process.platform (node/runtime.md 4): chmod first, icacls only
// when the read still succeeds. ONE skippable leg per test: the probe is the only conditional.
function denyRead(file) {
  try { fs.chmodSync(file, 0); if (readDenied(file)) return () => { try { fs.chmodSync(file, 0o600); } catch {} }; } catch {}
  try { fs.chmodSync(file, 0o600); } catch {}
  const me = os.userInfo().username;
  const r = spawnSync('icacls', [file, '/deny', me + ':(R)'], { encoding: 'utf8' });
  if (!r.error && r.status === 0 && readDenied(file)) return () => { try { spawnSync('icacls', [file, '/reset'], { encoding: 'utf8' }); } catch {} };
  try { spawnSync('icacls', [file, '/reset'], { encoding: 'utf8' }); } catch {}
  return null;
}
function readDenied(file) {
  try { fs.readFileSync(file); return false; } catch (e) { return !!(e && (e.code === 'EACCES' || e.code === 'EPERM')); }
}

test('UMB-174 (b) reason "unreadable": a config whose read is DENIED (EACCES or EPERM) is REPORTED', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 5 } });
  const restore = denyRead(canon);
  if (!restore) {
    t.skip('this volume/OS does not enforce a read denial for the owning process via chmod OR icacls -- cannot exercise EACCES/EPERM (' + process.platform + ')');
    return; // t.skip does not stop the body
  }
  try {
    for (const [name, api] of CJS_ESM) {
      assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(canon, 'unreadable')], name);
    }
  } finally {
    restore(); // in-body, not t.after: mkT's own cleanup is registered first and would run BEFORE it and hit the denied file
  }
});

test('UMB-174 (b) reason "not a JSON object": valid JSON that is not a plain object is REPORTED, and contributes nothing', (t) => {
  hermetic(t);
  const home = mkT(t);
  for (const body of ['[]', '"str"', '42', 'null', 'true']) {
    const { root, sub } = project(t);
    const canon = path.join(root, '.claude', 'coal', 'coalhearth.json');
    fs.mkdirSync(path.dirname(canon), { recursive: true });
    fs.writeFileSync(canon, body);
    for (const [name, api] of CJS_ESM) {
      assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(canon, 'not a JSON object')], name + ' ' + body);
    }
    assert.deepEqual(loadMergedConfig({ cwd: sub, home }), {}, body + ' is never accepted as the config');
  }
});

test('UMB-174 (b): a leading U+FEFF is STRIPPED before the parse -- a BOM-prefixed valid object is READ and not reported', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = path.join(root, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(path.dirname(canon), { recursive: true });
  fs.writeFileSync(canon, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"journal":{"atomicityRetries":6}}')]));
  assert.equal(loadMergedConfig({ cwd: sub, home }).journal.atomicityRetries, 6);
  for (const [name, api] of CJS_ESM) assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [], name);
});

// CWK-135 (a) supersedes the global half of this case: the GLOBAL line names the global file's OWN path (see below).
test('UMB-174 (b): the GLOBAL config is reported too, when it is present but unreadable', (t) => {
  hermetic(t);
  const { sub } = project(t);
  const home = mkT(t);
  const g = path.join(home, '.claude', '.coalhearth.json');
  fs.mkdirSync(path.dirname(g), { recursive: true });
  fs.writeFileSync(g, 'nope');
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(g, 'malformed JSON', g)], name);
  }
});

test('UMB-174 (b): an ABSENT config, and a readable one, emit no UNREADABLE line', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  for (const [name, api] of CJS_ESM) assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [], name + ' absent');
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 2 } });
  for (const [name, api] of CJS_ESM) assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [], name + ' readable');
});

test('UMB-174 (b): an unreadable LEGACY file is reported as UNREADABLE, never also claimed to be "still read" (LEGACY)', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const legacy = path.join(root, '.coalhearth.json');
  fs.writeFileSync(legacy, '{');
  for (const [name, api] of CJS_ESM) {
    const lines = api.configNotices({ cwd: sub, home });
    assert.deepEqual(lines, [unreadableLine(legacy, 'malformed JSON')], name);
  }
});

// CWK-135 (a): the UNREADABLE line names the path of the TIER that failed. The PROJECT tier keeps the
// verbatim flock string (canonical = .claude/coal/coalhearth.json -- a project config has a canonical
// place to move to). The GLOBAL tier names the global file's OWN path, because a global config has no
// project location to move to, and a line that says "canonical = <a project path>" for it would
// send the user to the wrong place (Standard System 4: a failure states what to do next). The path
// comes from the loader (globalConfigPath -- CLAUDE_CONFIG_DIR wins over the home dir), never a
// hardcoded ~/.claude.
test('CWK-135 (a): a GLOBAL config the walk cannot read names the GLOBAL file as its canonical, not a project path', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const g = path.join(home, '.claude', '.coalhearth.json');
  fs.mkdirSync(path.dirname(g), { recursive: true });
  fs.writeFileSync(g, '[1,2]');
  const canon = path.join(root, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(path.dirname(canon), { recursive: true });
  fs.writeFileSync(canon, '{');
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [
      unreadableLine(g, 'not a JSON object', g), // the global tier: its own path
      unreadableLine(canon, 'malformed JSON'),   // the project tier: the verbatim flock string, unchanged
    ], name);
  }
});

test('CWK-135 (a): the global path is DERIVED from the loader -- CLAUDE_CONFIG_DIR wins over the home dir', (t) => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
  const { sub } = project(t);
  const home = mkT(t);
  const cfgDir = mkT(t);
  const g = path.join(cfgDir, '.coalhearth.json');
  fs.writeFileSync(g, 'nope');
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  assert.equal(twin.globalConfigPath(home), g, 'the loader resolves the global path here');
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(g, 'malformed JSON', g)], name);
  }
});

// CWK-120 findings #2 + #3 (CodeRabbit, Major x2), verified at the live tree in BOTH twins: the merge loop resolves a
// MIXED tier (one side a group, the other side a present non-group) as ONE ATOM, so merged.update / merged.recovery can
// be a primitive; the post-clamp then assigned `merged.update.updateMode = ...` onto it -- a TypeError under strict mode
// (CJS 'use strict' and ESM alike). loadConfig()/loadMergedConfig() are called with no try/catch from bin/session-start.js
// and bin/ag-pre-invocation.js, so the throw escaped main() and killed the hook: a cloned repo could turn OFF journaling
// and recovery with one wrong-typed key (Phoenix #4: fail-silent). TRIGGER: global {"update":{"updateMode":"off"}} plus
// project {"update":5}.
//
// The bot's own fix (gate the clamp on a real group, keep the atom) stops the THROW but, taken alone, leaves the CLAMP's
// purpose undone: the project's scalar atom REPLACES the user's global group, erasing their quiet "off" -> the consumer
// reads no updateMode, ranks it as the schema default "ask", and the nudge the user silenced fires again. A project may
// only QUIETEN. So for the two consent groups a present-but-non-group project value contributes NOTHING and the global
// group stands (safer-value-wins: a malformed value cannot be quieter than a real one); the group gate is kept as a second belt.
const BAD_TIER_VALUES = [5, 'oops', true, [1, 2], null];

test('CWK-120 #2/#3: a non-object PROJECT value for a clamped group never throws (both twins), and the global consent stands', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { update: { updateMode: 'off' }, recovery: { autoInjectPrompt: false } });
  for (const bad of BAD_TIER_VALUES) {
    put(root, path.join('.claude', 'coal', 'coalhearth.json'), { update: bad, recovery: bad });
    for (const [name, api] of CJS_ESM) {
      const load = api === twin ? api.loadMergedConfig : api.loadConfig;
      let merged;
      assert.doesNotThrow(() => { merged = load({ cwd: sub, home }); }, name + ' ' + JSON.stringify(bad));
      assert.equal(merged.update.updateMode, 'off', name + ' ' + JSON.stringify(bad) + ': the user global "off" survives a wrong-typed project group');
      assert.equal(merged.recovery.autoInjectPrompt, false, name + ' ' + JSON.stringify(bad) + ': the user global autoInjectPrompt=false survives too');
    }
  }
});

test('CWK-120 #2/#3: a non-object GLOBAL value for a clamped group never throws either, and a real project group is still clamped', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { update: 'oops', recovery: 7 });
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { update: { updateMode: 'auto' }, recovery: { autoInjectPrompt: true } });
  for (const [name, api] of CJS_ESM) {
    const load = api === twin ? api.loadMergedConfig : api.loadConfig;
    let merged;
    assert.doesNotThrow(() => { merged = load({ cwd: sub, home }); }, name);
    assert.equal(merged.update.updateMode, 'ask', name + ': a non-group global ranks as the schema default, so a project "auto" is clamped to it (R2)');
    assert.equal(merged.recovery.autoInjectPrompt, true, name);
  }
});

test('CWK-120 #2/#3: with NO global at all a wrong-typed project group is kept as-is and never throws', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { update: 5, recovery: 'no' });
  for (const [name, api] of CJS_ESM) {
    const load = api === twin ? api.loadMergedConfig : api.loadConfig;
    let merged;
    assert.doesNotThrow(() => { merged = load({ cwd: sub, home }); }, name);
    assert.equal(merged.update, 5, name);
    assert.equal(merged.recovery, 'no', name);
  }
});

test('CWK-120 #2/#3: only the two CONSENT groups get this rule -- another group keeps the r29 one-atom project-wins (unchanged)', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { journal: { atomicityRetries: 4 } });
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: 9 });
  for (const [name, api] of CJS_ESM) {
    const load = api === twin ? api.loadMergedConfig : api.loadConfig;
    assert.equal(load({ cwd: sub, home }).journal, 9, name);
  }
});

// -- R8 FIXBACK L1: two reasons were not pinned on every OS ------------------------------------------------
// (1) BOTH errnos of `unreadable`. The real-denial test above proves whichever errno THIS platform's denial
// surfaces (EPERM through an NTFS ACL here); dropping EACCES from the map survived. The errno is INJECTED at
// fs.readFileSync (the way the lock test injects its errnos), so EACCES and EPERM are each pinned on every OS,
// in both twins.
function injectReadError(file, code) {
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file)) {
      const err = new Error(code + ': injected, open');
      err.code = code;
      throw err;
    }
    return real.call(this, p, ...rest);
  };
  return () => { fs.readFileSync = real; };
}

for (const code of ['EACCES', 'EPERM']) {
  test('UMB-174 (b) reason "unreadable": an injected ' + code + ' on the read is REPORTED (pinned on every OS, both twins)', (t) => {
    hermetic(t);
    const { root, sub } = project(t);
    const home = mkT(t);
    const canon = put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 5 } });
    const restore = injectReadError(canon, code);
    try {
      for (const [name, api] of CJS_ESM) {
        assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(canon, 'unreadable')], name + ' ' + code);
      }
    } finally {
      restore();
    }
  });
}

test('UMB-174 (b): an injected error code that is NOT one of the four reasons stays SILENT (never a fifth reason)', (t) => {
  hermetic(t);
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 5 } });
  const restore = injectReadError(canon, 'EBUSY');
  try {
    for (const [name, api] of CJS_ESM) assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [], name);
  } finally {
    restore();
  }
});

// (2) `a directory`, at the GLOBAL path -- the only place readConfigFile still meets a directory after CWK-127
// (the project selector never picks one). It names the global file's own path (CWK-135 a).
test('UMB-174 (b) reason "a directory": a DIRECTORY at the GLOBAL path is reported, naming the global file (both twins)', (t) => {
  hermetic(t);
  const { sub } = project(t);
  const home = mkT(t);
  const g = path.join(home, '.claude', '.coalhearth.json');
  fs.mkdirSync(g, { recursive: true });
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: sub, home }), [unreadableLine(g, 'a directory', g)], name);
  }
});

// R8 FIXBACK L2: at root == home the nested legacy candidate IS the global path. The selector already excludes
// it (isGlobalConfig), but the notice loop's stepped-over branch did not, so ONE directory was reported twice with
// two contradictory targets: the global line (canonical = that same path) and a project line (canonical =
// .claude/coal/coalhearth.json). One path, one line -- the GLOBAL tier's (CWK-135 a).
test('L2: root == home with a DIRECTORY at the global path reports it ONCE, with the global tier canonical (both twins)', (t) => {
  hermetic(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(home, '.git')); // home is itself the project root
  const g = path.join(home, '.claude', '.coalhearth.json');
  fs.mkdirSync(g, { recursive: true });
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: home, home }), [unreadableLine(g, 'a directory', g)], name);
  }
});

test('L2: a directory at a canonical path is STILL reported when root == home (only the global path is skipped)', (t) => {
  hermetic(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(home, '.git'));
  const dir = path.join(home, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, api] of CJS_ESM) {
    assert.deepEqual(unreadableOf(api, { cwd: home, home }), [unreadableLine(dir, 'a directory')], name);
  }
});
