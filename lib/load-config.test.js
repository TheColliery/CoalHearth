// Run: node --test lib/load-config.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./load-config');

function mk() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-cfg-'));
}

test('no config anywhere -> empty object, never throws', () => {
  const cwd = mk();
  const home = mk();
  assert.doesNotThrow(() => {
    assert.deepStrictEqual(loadConfig({ cwd, home }), {});
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('project config found by walking up from a subdir', () => {
  const root = mk();
  const home = mk();
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 5 } }));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const cfg = loadConfig({ cwd: sub, home });
  assert.strictEqual(cfg.journal.atomicityRetries, 5);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('project overlays global, per-group shallow merge', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.coalhearth.json'),
    JSON.stringify({ journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 5 } })
  );
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 3 } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.journal.atomicityRetries, 3, 'project overrides global');
  assert.strictEqual(cfg.journal.outputDirectory, '.claude/coalhearth', 'global key not overridden is kept');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('walk stops at home -- a .coalhearth.json ABOVE home is ignored', () => {
  const base = mk();
  fs.writeFileSync(path.join(base, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 4 } }));
  const home = path.join(base, 'h');
  fs.mkdirSync(home, { recursive: true });
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.journal, undefined, 'the config above home must never be picked up');
  fs.rmSync(base, { recursive: true, force: true });
});

// hooks-safety.md §9 (config-cascade clamp): the project layer arrives with an
// untrusted cloned repo and may only QUIETEN update.updateMode relative to the
// trusted global config, never escalate it. RED-PROOF: revert loadConfig to the
// plain per-group shallow merge (no updateMode post-clamp) and this goes red
// (cfg.update.updateMode would read 'auto', not 'off').
test('consent-cascade clamp: a project cannot re-escalate a user-silenced updateMode (hooks-safety.md §9)', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.update.updateMode, 'off', 'a project must not turn a user-silenced update nudge back on');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('consent-cascade clamp: a project MAY still quieten updateMode below global', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.update.updateMode, 'off', 'quietening still works — the clamp is one-directional, not a lock');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

// R2 (hooks-safety.md §9 amendment, 2026-07-27): a user who never wrote a GLOBAL
// config still has a stance — the schema's declared default (updateMode: ask). The
// first cut here skipped the clamp entirely when global was unset ("if
// (typeof globalMode !== 'string') return projectMode"), so no-global + project
// 'auto' returned 'auto' uncalmped. RED-PROOF: revert the schema-default rank and
// this goes red (reads 'auto', not 'ask').
test('R2 factory-default: NO global config at all still clamps project updateMode to the schema default (ask)', () => {
  const home = mk();
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const cfg = loadConfig({ cwd: proj, home }); // no ~/.claude/.coalhearth.json at all
  assert.strictEqual(cfg.update.updateMode, 'ask', 'an absent global is the schema default (ask), not a clamp skip');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

// R3 (hooks-safety.md §9): recovery.autoInjectPrompt is CH's second hook-read consent
// key (gates the whole recovery-block injection). RED-PROOF: drop the clamp and this
// goes red (reads true, not false).
test('R3 consent-cascade clamp: a project cannot re-escalate a user-silenced autoInjectPrompt', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: false } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: true } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.recovery.autoInjectPrompt, false, 'a project must not turn a user-silenced recovery injection back on');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('R3 consent-cascade clamp: a project MAY still quieten autoInjectPrompt to false', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: true } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ recovery: { autoInjectPrompt: false } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.recovery.autoInjectPrompt, false, 'quietening still works');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('R3: stashUnsavedChanges stays plain project-wins, unclamped (correctly out of scope)', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ recovery: { stashUnsavedChanges: false } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ recovery: { stashUnsavedChanges: true } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.recovery.stashUnsavedChanges, true, 'an advisory-only key is plain project-wins, no clamp');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('consent-cascade clamp: an unrecognized project value cannot escalate either (treated as loudest)', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'yolo' } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.update.updateMode, 'off', 'garbage never wins over a real quieter global value');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('malformed JSON -> degrades to {} for that file, never throws', () => {
  const cwd = mk();
  const home = mk();
  fs.writeFileSync(path.join(cwd, '.coalhearth.json'), '{ not valid json');
  assert.doesNotThrow(() => {
    const cfg = loadConfig({ cwd, home });
    assert.deepStrictEqual(cfg, {});
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
