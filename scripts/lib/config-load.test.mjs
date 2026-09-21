import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, projectConfigPath, loadMergedConfig } from './config-load.mjs';
import * as twin from './config-load.mjs'; // UMB-133: namespace import so a missing export fails PER TEST, not at link time
import { createRequire } from 'node:module';

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
];

for (const fx of TWIN_FIXTURES) {
  test('UMB-133 twin agreement: ' + fx.name, (t) => {
    const { root, sub } = project(t);
    const home = mkT(t);
    put(home, path.join('.claude', '.coalhearth.json'), { update: { updateMode: 'ask' } });
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
