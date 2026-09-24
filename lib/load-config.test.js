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

// --- Namespace campaign (#69+#39, owner-designated 2026-08-08) ---------------------

test('namespace campaign: own-dir wins over other agent dirs and the legacy root file', () => {
  const root = mk();
  const home = mk();
  fs.mkdirSync(path.join(root, '.claude', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 1 } }));
  fs.mkdirSync(path.join(root, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 2 } }));
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 3 } }));
  const cfg = loadConfig({ cwd: root, home, ownDir: '.agents' });
  assert.strictEqual(cfg.journal.atomicityRetries, 2, 'the running agent reads ITS OWN dir first, ahead of .claude and legacy');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('namespace campaign: another known agent dir is found (first-found-wins) when own-dir has nothing', () => {
  const root = mk();
  const home = mk();
  fs.mkdirSync(path.join(root, '.gemini', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gemini', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 7 } }));
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 9 } }));
  const cfg = loadConfig({ cwd: root, home, ownDir: '.claude' }); // own dir (.claude) has nothing
  assert.strictEqual(cfg.journal.atomicityRetries, 7, '.gemini is found via the fixed fallback order, ahead of the legacy root file');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('namespace campaign: legacy root dotfile is read when no agent-dir candidate exists anywhere', () => {
  const root = mk();
  const home = mk();
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 11 } }));
  const cfg = loadConfig({ cwd: root, home, ownDir: '.agents' });
  assert.strictEqual(cfg.journal.atomicityRetries, 11, 'the legacy shape is still read normally -- no breakage for an existing user');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// Root-marker widening (item 1): a project configured ONLY through the new shape (no
// .git, no legacy dotfile) must still anchor correctly, not fall through to startDir.
test('namespace campaign: findProjectRoot anchors on a NEW-shape marker alone (no .git, no legacy dotfile)', () => {
  const root = mk();
  const home = mk();
  fs.mkdirSync(path.join(root, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 42 } }));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const cfg = loadConfig({ cwd: sub, home, ownDir: '.agents' });
  assert.strictEqual(cfg.journal.atomicityRetries, 42, 'walking up from a subdir must anchor on the new-shape-only root');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// Additive-only proof: widening ROOT_MARKERS must never make the walk skip a NEARER
// root to reach a farther one -- it can only make the walk stop LOWER (nearer), never
// wider. A nested project (root/sub, itself a root via a new-shape marker) must still
// win over the outer root (an old-shape .git) when walking from inside sub.
test('namespace campaign: root-marker widening never widens the walk -- the NEARER root still wins', () => {
  const outer = mk();
  const home = mk();
  fs.writeFileSync(path.join(outer, '.git'), ''); // old-shape marker at the OUTER root
  fs.writeFileSync(path.join(outer, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 100 } }));
  const inner = path.join(outer, 'sub');
  fs.mkdirSync(path.join(inner, '.agents', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(inner, '.agents', 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 200 } })); // new-shape marker, NEARER
  const deep = path.join(inner, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  const cfg = loadConfig({ cwd: deep, home, ownDir: '.agents' });
  assert.strictEqual(cfg.journal.atomicityRetries, 200, 'the walk stops at the NEARER root (inner), never skips past it to the farther outer one');
  fs.rmSync(outer, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// Clamp-unchanged regression (item 4): the safer-value-wins semantics must not depend
// on WHICH candidate address supplied the project value -- only the file's ADDRESS
// moved, never the cascade rule. RED-PROOF: this would read 'auto' (escalated) if the
// clamp were somehow keyed to the legacy path specifically instead of "the project
// layer, wherever it was found".
test('namespace campaign: the consent-cascade clamp is unchanged regardless of WHICH candidate supplied the project value', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'off' } }));
  const root = mk();
  fs.mkdirSync(path.join(root, '.gemini', 'coal'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gemini', 'coal', 'coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const cfg = loadConfig({ cwd: root, home, ownDir: '.gemini' });
  assert.strictEqual(cfg.update.updateMode, 'off', 'a project value found at a NEW-shape candidate is clamped exactly like the legacy shape was');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
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

// AL-2: `language` is a top-level SCALAR, not a group -- spreading a string as though it
// were an object would explode it into indexed characters ({0:'a',1:'u',...}). RED-PROOF:
// reverting the loadConfig merge loop to the old unconditional `{...(global[g]||{}),
// ...(project[g]||{})}` shape makes every case below fail (either an exploded-char object
// where a plain string is expected, or a crash on a project/global side that never set the
// key at all).
test('AL-2: a top-level scalar (language) is NOT spread -- project wins outright, no per-key merge', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'en' }));
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.language, 'th', 'project scalar wins outright, and is not exploded into an object');
});

test('AL-2: a scalar set only globally falls back correctly when the project never touches it', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'ja' }));
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 2 } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.language, 'ja', 'global scalar survives when the project config never sets the key');
  assert.strictEqual(cfg.journal.atomicityRetries, 2, 'a real GROUP alongside the scalar still merges per-key, unaffected');
});

test('AL-2: a scalar set only by the project (no global at all) survives -- and every existing group merge is unaffected', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(proj, '.coalhearth.json'),
    JSON.stringify({ language: 'zh', recovery: { stashUnsavedChanges: false } })
  );
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.language, 'zh');
  assert.strictEqual(cfg.recovery.stashUnsavedChanges, false, 'a real GROUP with no global counterpart still merges to a fresh object, not a shared reference');
});

test('AL-2: a real GROUP still merges as a fresh per-key object, never mutating the source config it was copied from', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ update: { updateMode: 'auto' } }));
  const cfg = loadConfig({ cwd: proj, home });
  cfg.update.updateMode = 'off'; // mutate the RETURNED object
  const cfgAgain = loadConfig({ cwd: proj, home }); // a fresh call re-reads from disk
  assert.strictEqual(cfgAgain.update.updateMode, 'auto', 'the merged group is a fresh copy every call, not a cached reference the caller can corrupt');
});

// r29 findings-back LOW 3 — a MIXED tier (one side a group, the other a present scalar)
// used to run the group-merge branch regardless and silently discard whichever side was
// not object-shaped. RED-PROOF: reverting to the old `if (!gIsGroup && !pIsGroup) {...}
// continue; merged[key] = {...(gIsGroup?g:{}), ...(pIsGroup?p:{})}` shape makes both cases
// below produce `{}` / `{a:1}` instead of the valid scalar -- both tests fail together.
test('AL-2 LOW-3: project scalar wins over global group-garbage (mixed tier, project-wins preserved)', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: { a: 1 } }));
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.language, 'th', 'a present project scalar wins outright over a global object, mixed-shape or not');
});

test('AL-2 LOW-3: global scalar falls back correctly when the project supplies a mixed-shape value', (t) => {
  const home = mk();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = mk();
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ language: 'th' }));
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ language: {} }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.deepStrictEqual(cfg.language, {}, 'a present project value (however wrong-shaped) still wins outright -- resolving that is validateConfig\'s job, not the merge\'s');
});

// ---------------------------------------------------------------------------------------
// UMB-133 (config-path unification). Five proofs + the clamp/collision guards. Each temp
// dir is registered for cleanup on the line after it is allocated (scripts-quality.md 2).
// The ESM twin (scripts/lib/config-load.test.mjs) carries the same cases plus the
// twin-agreement table -- keep the two files' case names in step.
// ---------------------------------------------------------------------------------------
const { configNotices, findProjectRoot } = require('./load-config');

function mkT(t) {
  // physical path, registered for cleanup before anything else can throw
  const d = fs.realpathSync(mk());
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function put(dir, rel, obj) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
// a .git-anchored project with a subdir to run from (the ordinary shape)
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
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 7);
});

test('UMB-133 proof 2: <root>/.coalhearth.json (root legacy) is still found', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, '.coalhearth.json', { journal: { atomicityRetries: 8 } });
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 8);
});

test('UMB-133 proof 3: canonical wins over BOTH legacies, and nested legacy wins over root legacy', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  const canon = put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 1 } });
  const nested = put(root, NESTED, { journal: { atomicityRetries: 2 } });
  put(root, '.coalhearth.json', { journal: { atomicityRetries: 3 } });
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 1, 'canonical first');
  fs.rmSync(canon);
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 2, 'nested legacy before root legacy');
  fs.rmSync(nested);
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 3, 'root legacy last');
});

test('UMB-133 proof 4: a config at a NON-candidate path is REPORTED, never silently walked past', (t) => {
  // every mis-combination of {agent dir | root} x {'' | coal} x {coalhearth.json | .coalhearth.json}
  // that is not a candidate -- a sample of the generated set, one line each.
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
    assert.deepStrictEqual(
      configNotices({ cwd: sub, home }),
      ['IGNORED: ' + f + ' is not a config path; ' + CANON_TAIL],
      rel + ' must be reported exactly once'
    );
    assert.strictEqual(loadConfig({ cwd: sub, home }).journal, undefined, rel + ' is still NOT read (report, never adopt)');
  }
});

test('UMB-133 proof 4b: the probe is a CLOSED set at the walk\'s own root, not a filesystem crawl', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  // (a stray `coalhearth.json` -- NOT `.coalhearth.json`, which below the root would itself BE the root)
  put(sub, 'coalhearth.json', {});
  put(root, path.join('other', '.coalhearth.json'), {}); // a dir the walk never reads
  put(root, path.join('.claude', 'deep', 'coalhearth.json'), {});
  assert.deepStrictEqual(configNotices({ cwd: sub, home }), []);
});

test('UMB-133 proof 5: a legacy hit emits ONE line naming the canonical path (both legacy shapes)', (t) => {
  for (const rel of [NESTED, '.coalhearth.json']) {
    const { root, sub } = project(t);
    const home = mkT(t);
    const f = put(root, rel, { journal: { atomicityRetries: 5 } });
    const lines = configNotices({ cwd: sub, home });
    assert.strictEqual(lines.length, 1, rel + ': exactly one line');
    assert.ok(lines[0].includes(f), 'names the legacy file it read');
    assert.ok(lines[0].includes(CANON_TAIL), 'names the canonical path');
    assert.ok(!lines[0].includes('\n'), 'one line');
  }
});

test('UMB-133: a canonical config, or none at all, emits no notice', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  assert.deepStrictEqual(configNotices({ cwd: sub, home }), []);
  put(root, path.join('.claude', 'coal', 'coalhearth.json'), { journal: { atomicityRetries: 1 } });
  assert.deepStrictEqual(configNotices({ cwd: sub, home }), []);
});

test('UMB-133: configNotices never throws (a cwd that does not exist)', (t) => {
  const home = mkT(t);
  assert.doesNotThrow(() => configNotices({ cwd: path.join(home, 'no', 'such', 'dir'), home }));
});

// hooks-safety.md 9: this unit changes WHERE a project config is found, never how it merges.
// RED-PROOF: swap the post-clamp for a plain project-wins overlay and the first case reads 'auto'.
test('UMB-133 clamp: a config found at the NESTED legacy path is still clamped safer-value-wins', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { update: { updateMode: 'off' }, recovery: { autoInjectPrompt: false } });
  put(root, NESTED, { update: { updateMode: 'auto' }, recovery: { autoInjectPrompt: true } });
  const cfg = loadConfig({ cwd: sub, home });
  assert.strictEqual(cfg.update.updateMode, 'off', 'a project may not re-escalate a user-silenced nudge');
  assert.strictEqual(cfg.recovery.autoInjectPrompt, false, 'a project may not re-enable a user-silenced injection');
});

test('UMB-133 clamp: R2 factory-default still applies to a nested-legacy project with NO global', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  put(root, NESTED, { update: { updateMode: 'auto' } });
  assert.strictEqual(loadConfig({ cwd: sub, home }).update.updateMode, 'ask');
});

// ROOT_MARKERS ruling: `.claude/.coalhearth.json` is NOT a root marker, because at home it IS the
// global config. RED-PROOF: add that path to ROOT_MARKERS and (a) the walk below anchors at home,
// (b) the global file is then read a second time as the project's "legacy" config.
test('UMB-133 ROOT_MARKERS ruling: the global config never anchors a root or reads as a project legacy', (t) => {
  const home = mkT(t);
  put(home, path.join('.claude', '.coalhearth.json'), { journal: { atomicityRetries: 4 } });
  const proj = path.join(home, 'proj', 'src');
  fs.mkdirSync(proj, { recursive: true });
  assert.strictEqual(findProjectRoot(proj, home), proj, 'no marker of ours between here and home -> startDir, not home');
  assert.deepStrictEqual(configNotices({ cwd: proj, home }), []);
  // and with cwd AT home, the nested-legacy candidate IS the global file: not a legacy hit
  assert.deepStrictEqual(configNotices({ cwd: home, home }), []);
  assert.strictEqual(loadConfig({ cwd: home, home }).journal.atomicityRetries, 4);
});

// CWK-127 -- CJS twin of the scripts/lib/config-load.test.mjs cases (see the reasoning there).
test('CWK-127: a DIRECTORY at the nested-legacy path never shadows the real root-legacy config', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(root, NESTED), { recursive: true });
  const real = put(root, '.coalhearth.json', { journal: { atomicityRetries: 7 } });
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 7);
  const lines = configNotices({ cwd: sub, home });
  assert.ok(lines.some((l) => l.startsWith('LEGACY: ' + real)), JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.startsWith('LEGACY: ' + path.join(root, NESTED))));
});

test('CWK-127: a DIRECTORY at a CANONICAL path never shadows a real legacy config either', (t) => {
  const { root, sub } = project(t);
  const home = mkT(t);
  fs.mkdirSync(path.join(root, '.claude', 'coal', 'coalhearth.json'), { recursive: true });
  put(root, NESTED, { journal: { atomicityRetries: 8 } });
  assert.strictEqual(loadConfig({ cwd: sub, home }).journal.atomicityRetries, 8);
});

test('CWK-127: a directory named like a config MARKER does not anchor the walk (a marker must be a file)', (t) => {
  const home = mkT(t);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.coalhearth.json'), { recursive: true });
  const sub = path.join(proj, 'src');
  fs.mkdirSync(sub, { recursive: true });
  assert.strictEqual(findProjectRoot(sub, home), sub);
  fs.mkdirSync(path.join(proj, '.git'));
  assert.strictEqual(findProjectRoot(sub, home), proj);
});
