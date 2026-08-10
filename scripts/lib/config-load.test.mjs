import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, projectConfigPath, loadMergedConfig } from './config-load.mjs';

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
