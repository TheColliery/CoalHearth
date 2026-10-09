// CWK-137 (R14) -- the unbounded-read / link-following-write class, in CoalHearth. The class, from CoalMine's
// v3.20.2: every READ of a file a cloned repo can plant needs an lstat kind gate before the open, O_NONBLOCK, an
// fstat on the opened fd, and a size bound (over the bound = SKIPPED, never truncated); every WRITE, DELETE or
// RENAME through a repo-derived path needs realpath-and-contain (fs.realpathSync.native on BOTH sides).
//
// Every fixture lives under os.tmpdir() and is removed with the links unlinked FIRST (a junction is never walked).
// A case this volume cannot build (a FIFO, a device, a file symlink without privilege) is a capability-PROBED,
// VISIBLE t.skip -- one skippable leg per test -- and is CI-measured on ubuntu/macOS, never manufactured here.
// The "never OPENED" cases spy on fs.openSync / fs.readFileSync and refuse the open themselves, so a pre-cure run
// goes red without ever reading a device.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cjsLoad = require('../../lib/load-config.js');
const esmLoad = await import('./config-load.mjs');
const { HandoffJournal, atomicWriteJournal } = require('../../lib/handoff-journal.js');
const { ResumeEngine } = require('../../lib/resume-engine.js');
const { buildStateSnapshot } = require('../../lib/state-snapshot.js');

// The bounds, restated here on purpose (repo-fs.test.js asserts the shipped constants equal these).
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

delete process.env.CLAUDE_CONFIG_DIR; // the global path honours it before `home`; one process per test file

function unlinkLinks(dir, depth = 0) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let l;
    try { l = fs.lstatSync(p); } catch { continue; }
    if (l.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} } }
    else if (l.isDirectory()) unlinkLinks(p, depth + 1);
  }
}
// The fixture root is CANONICAL: fs.realpathSync.native, never plain fs.realpathSync. On a Windows runner os.tmpdir() is spelled with an 8.3 alias
// (C:\Users\RUNNER~1\...) that plain realpathSync leaves alone and .native expands, and the reader under test compares realpath.native of the
// candidate against realpath.native of the root. A test that PRETENDS a link (pretendLink, below) hands the reader a target string exactly as a real
// realpath.native would return it, i.e. already canonical, so a fixture spelled through the alias made every contained link read as an escape (R14 RED).
function mk(t, prefix = 'ch-cwk137-') {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => { unlinkLinks(d); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
// Remove ONE link and nothing else. unlink answers a POSIX symlink (rmdir answers ENOTDIR for one: R14 RED); a Windows junction answers to rmdir.
// Asserted here, so a wrong call can never delete a target: the path is inside the fixture root, it IS a link, it is gone afterwards, and the target
// it pointed at is still there.
function removeLink(p, root, targetThatMustSurvive) {
  const base = fs.realpathSync.native(root) + path.sep;
  assert.ok(path.resolve(p).startsWith(base), 'the link to remove sits inside the fixture root: ' + p);
  assert.ok(fs.lstatSync(p).isSymbolicLink(), 'and it is a link: ' + p);
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  assert.throws(() => fs.lstatSync(p), (e) => e.code === 'ENOENT', 'the link is gone');
  assert.ok(fs.existsSync(targetThatMustSurvive), 'and what it pointed at is untouched: ' + targetThatMustSurvive);
}
// A project: a directory carrying a .git marker, so the config walk and the journal anchor stop there.
function project(t) {
  const root = mk(t, 'ch-cwk137-proj-');
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}
function link(target, p, dir) {
  try { fs.symlinkSync(target, p, dir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); return true; } catch { return false; }
}
function mkfifo(p) {
  if (process.platform === 'win32') return false;
  const r = spawnSync('mkfifo', [p]);
  try { return !r.error && r.status === 0 && fs.lstatSync(p).isFIFO(); } catch { return false; }
}
// Spy: record every path opened for reading, and REFUSE (throw) the denied ones so no device is ever really read.
function spyOpens(deny) {
  const real = { openSync: fs.openSync, readFileSync: fs.readFileSync };
  const seen = [];
  const guard = (p) => {
    if (typeof p !== 'string') return;
    const r = path.resolve(p);
    seen.push(r);
    if (deny.some((d) => path.resolve(d) === r)) { const e = new Error('SPY: refused to open ' + p); e.code = 'ESPY'; throw e; }
  };
  fs.openSync = function (p, ...a) { guard(p); return real.openSync.call(this, p, ...a); };
  fs.readFileSync = function (p, ...a) { guard(p); return real.readFileSync.call(this, p, ...a); };
  return { seen, restore() { fs.openSync = real.openSync; fs.readFileSync = real.readFileSync; } };
}
function paddedJson(obj, size) { // a valid JSON object padded with trailing spaces to EXACTLY `size` bytes
  const body = JSON.stringify(obj);
  assert.ok(body.length <= size);
  return body + ' '.repeat(size - body.length);
}
const TWINS = [['esm', esmLoad], ['cjs', cjsLoad]];
const unreadableLine = (p, reason) => 'UNREADABLE: ' + p + ' exists but is not a readable config (' + reason + '); it was skipped — canonical = .claude/coal/coalhearth.json';
const globalUnreadableLine = (p, reason) => 'UNREADABLE: ' + p + ' exists but is not a readable config (' + reason + '); it was skipped — canonical = ' + p;
const unreadableOf = (api, opts) => api.configNotices(opts).filter((l) => l.startsWith('UNREADABLE:'));

// ---- the config loaders (both twins) --------------------------------------------------------------------------

test('CWK-137: a project config at exactly MAX_CONFIG_BYTES is honored, one byte over is SKIPPED and reported (both twins)', (t) => {
  const root = project(t);
  const home = mk(t);
  const cfg = path.join(root, '.claude', 'coal', 'coalhearth.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, paddedJson({ journal: { atomicityRetries: 7 } }, MAX_CONFIG_BYTES));
  for (const [name, api] of TWINS) {
    assert.equal(api.loadMergedConfig ? api.loadMergedConfig({ cwd: root, home }).journal.atomicityRetries : api.loadConfig({ cwd: root, home }).journal.atomicityRetries, 7, name + ' at the bound');
  }
  fs.writeFileSync(cfg, paddedJson({ journal: { atomicityRetries: 7 } }, MAX_CONFIG_BYTES + 1));
  for (const [name, api] of TWINS) {
    const merged = api.loadMergedConfig ? api.loadMergedConfig({ cwd: root, home }) : api.loadConfig({ cwd: root, home });
    assert.equal(merged.journal, undefined, name + ': an over-bound config is skipped, never truncated or parsed');
    assert.deepEqual(unreadableOf(api, { cwd: root, home }), [unreadableLine(cfg, 'unreadable')], name + ': and it is REPORTED');
  }
});

test('CWK-137: an over-bound GLOBAL config is skipped and reported (both twins)', (t) => {
  const root = project(t);
  const home = mk(t);
  const g = path.join(home, '.claude', '.coalhearth.json');
  fs.mkdirSync(path.dirname(g), { recursive: true });
  fs.writeFileSync(g, paddedJson({ update: { updateMode: 'off' } }, MAX_CONFIG_BYTES + 1));
  for (const [name, api] of TWINS) {
    const merged = api.loadMergedConfig ? api.loadMergedConfig({ cwd: root, home }) : api.loadConfig({ cwd: root, home });
    assert.equal(merged.update, undefined, name);
    assert.deepEqual(unreadableOf(api, { cwd: root, home }), [globalUnreadableLine(g, 'unreadable')], name);
  }
});

test('CWK-137: a project config reached through a junction/symlink that ESCAPES the project is refused; one that stays inside is honored (both twins)', (t) => {
  const root = project(t);
  const home = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const inside = path.join(root, 'real-coal');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'coal'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'coal', 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 9 } }));
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 4 } }));
  if (!link(path.join(outside, 'coal'), path.join(root, '.claude', 'coal'), true)) {
    t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')');
    return;
  }
  const cfg = path.join(root, '.claude', 'coal', 'coalhearth.json');
  for (const [name, api] of TWINS) {
    const merged = api.loadMergedConfig ? api.loadMergedConfig({ cwd: root, home }) : api.loadConfig({ cwd: root, home });
    assert.equal(merged.journal, undefined, name + ': a config outside the project is never loaded through the link');
    assert.deepEqual(unreadableOf(api, { cwd: root, home }), [unreadableLine(cfg, 'unreadable')], name);
  }
  // control: the same link aimed INSIDE the project stays allowed
  removeLink(path.join(root, '.claude', 'coal'), root, path.join(outside, 'coal', 'coalhearth.json'));
  assert.ok(link(inside, path.join(root, '.claude', 'coal'), true));
  for (const [name, api] of TWINS) {
    const merged = api.loadMergedConfig ? api.loadMergedConfig({ cwd: root, home }) : api.loadConfig({ cwd: root, home });
    assert.equal(merged.journal.atomicityRetries, 4, name + ': a contained link is honored');
  }
});

for (const [name, modPath] of [['cjs', '../../lib/load-config.js'], ['esm', './config-load.mjs']]) {
  test('CWK-137: a FIFO at the GLOBAL config path never hangs the loader (' + name + ')', (t) => {
    const root = project(t);
    const home = mk(t);
    const g = path.join(home, '.claude', '.coalhearth.json');
    fs.mkdirSync(path.dirname(g), { recursive: true });
    if (!mkfifo(g)) {
      t.skip('mkfifo unavailable here (' + process.platform + ') -- CI-measured on ubuntu/macOS');
      return;
    }
    const script = name === 'cjs'
      ? 'const m=require(' + JSON.stringify(path.resolve(path.dirname(fileURLToPath(import.meta.url)), modPath)) + ');m.loadConfig({cwd:process.argv[1],home:process.argv[2]});process.stdout.write("done")'
      : 'import(' + JSON.stringify(new URL(modPath, import.meta.url).href) + ').then((m)=>{m.loadMergedConfig({cwd:process.argv[1],home:process.argv[2]});process.stdout.write("done")})';
    const r = spawnSync(process.execPath, ['-e', script, root, home], { encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_CONFIG_DIR: '' } });
    assert.equal(r.stdout, 'done', 'the loader returned instead of blocking on the FIFO (' + (r.error ? r.error.code : 'status ' + r.status) + ')');
  });

  test('CWK-137: a global config that is a symlink to a device is never OPENED (' + name + ')', (t) => {
    const root = project(t);
    const home = mk(t);
    const g = path.join(home, '.claude', '.coalhearth.json');
    fs.mkdirSync(path.dirname(g), { recursive: true });
    if (!fs.existsSync('/dev/zero') || !link('/dev/zero', g, false)) {
      t.skip('no /dev/zero or no file symlink here (' + process.platform + ') -- CI-measured on ubuntu/macOS');
      return;
    }
    const spy = spyOpens([g]);
    try {
      const api = name === 'cjs' ? cjsLoad : esmLoad;
      if (api.loadMergedConfig) api.loadMergedConfig({ cwd: root, home }); else api.loadConfig({ cwd: root, home });
    } finally { spy.restore(); }
    assert.deepEqual(spy.seen.filter((p) => p === path.resolve(g)), [], 'the device was never opened');
  });
}

// ---- state-snapshot: task.md and AGENTS.md ---------------------------------------------------------------------

test('CWK-137: AGENTS.md at exactly MAX_DOC_BYTES is parsed, one byte over is SKIPPED (constraints [])', (t) => {
  const dir = mk(t);
  const body = '## Constraints\n- keep me\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), body + ' '.repeat(MAX_DOC_BYTES - body.length));
  assert.deepEqual(buildStateSnapshot(dir).activePlan.constraints, ['keep me'], 'at the bound');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), body + ' '.repeat(MAX_DOC_BYTES + 1 - body.length));
  assert.deepEqual(buildStateSnapshot(dir).activePlan.constraints, [], 'one byte over: skipped, never truncated');
});

test('CWK-137: task.md at exactly MAX_DOC_BYTES is parsed, one byte over is SKIPPED (empty goal)', (t) => {
  const dir = mk(t);
  const body = '## The goal\n- [ ] one step\n';
  fs.writeFileSync(path.join(dir, 'task.md'), body + ' '.repeat(MAX_DOC_BYTES - body.length));
  assert.equal(buildStateSnapshot(dir).activePlan.goal, 'The goal', 'at the bound');
  fs.writeFileSync(path.join(dir, 'task.md'), body + ' '.repeat(MAX_DOC_BYTES + 1 - body.length));
  const s = buildStateSnapshot(dir);
  assert.equal(s.activePlan.goal, '', 'one byte over: skipped');
  assert.deepEqual(s.checklist, []);
});

test('CWK-137: an AGENTS.md symlink that escapes the workspace is refused; one that stays inside is honored', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  fs.writeFileSync(path.join(outside, 'secret.md'), '## Constraints\n- from outside\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '## Constraints\n- from inside\n');
  if (!link(path.join(outside, 'secret.md'), path.join(dir, 'AGENTS.md'), false)) {
    t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS');
    return;
  }
  assert.deepEqual(buildStateSnapshot(dir).activePlan.constraints, [], 'an escaping link is never read');
  fs.unlinkSync(path.join(dir, 'AGENTS.md'));
  assert.ok(link(path.join(dir, 'CLAUDE.md'), path.join(dir, 'AGENTS.md'), false));
  assert.deepEqual(buildStateSnapshot(dir).activePlan.constraints, ['from inside'], 'a contained link is honored');
});

test('CWK-137: an AGENTS.md that is a symlink to a device is never OPENED', (t) => {
  const dir = mk(t);
  const p = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync('/dev/zero') || !link('/dev/zero', p, false)) {
    t.skip('no /dev/zero or no file symlink here (' + process.platform + ') -- CI-measured on ubuntu/macOS');
    return;
  }
  const spy = spyOpens([p]);
  try { buildStateSnapshot(dir); } finally { spy.restore(); }
  assert.deepEqual(spy.seen.filter((q) => q === path.resolve(p)), [], 'the device was never opened');
});

// ---- the journal reads (HandoffJournal.load, ResumeEngine.detectAbortedSession) -----------------------------------

const JOURNAL = 'session_handoff.json';
const LIVE = { status: 'in_progress', sessionId: 's1' };

test('CWK-137: a journal at exactly MAX_JOURNAL_BYTES is read, one byte over is SKIPPED and never quarantined', (t) => {
  const dir = mk(t);
  const j = path.join(dir, JOURNAL);
  fs.writeFileSync(j, paddedJson(LIVE, MAX_JOURNAL_BYTES));
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).load().sessionId, 's1', 'load at the bound');
  assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession().sessionId, 's1', 'detect at the bound');
  fs.writeFileSync(j, paddedJson(LIVE, MAX_JOURNAL_BYTES + 1));
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).load(), null, 'load one byte over');
  assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession(), null, 'detect one byte over: boot clean');
  assert.equal(fs.existsSync(path.join(dir, 'session_handoff.corrupt.json')), false, 'an over-bound journal is not "corrupt": nothing is quarantined');
  assert.equal(fs.statSync(j).size, MAX_JOURNAL_BYTES + 1, 'and it is left in place');
});

test('CWK-137: a journal that is a symlink to a file outside the output dir is refused; one that stays inside is honored', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  fs.writeFileSync(path.join(outside, 'x.json'), JSON.stringify({ status: 'in_progress', sessionId: 'outside' }));
  fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify({ status: 'in_progress', sessionId: 'inside' }));
  if (!link(path.join(outside, 'x.json'), path.join(dir, JOURNAL), false)) {
    t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS');
    return;
  }
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).load(), null, 'load through an escaping link');
  assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession(), null, 'detect through an escaping link');
  fs.unlinkSync(path.join(dir, JOURNAL));
  assert.ok(link(path.join(dir, 'real.json'), path.join(dir, JOURNAL), false));
  assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession().sessionId, 'inside', 'a contained link is honored');
});

test('CWK-137: a FIFO at the journal path never hangs ResumeEngine or HandoffJournal', (t) => {
  const dir = mk(t);
  if (!mkfifo(path.join(dir, JOURNAL))) {
    t.skip('mkfifo unavailable here (' + process.platform + ') -- CI-measured on ubuntu/macOS');
    return;
  }
  const script = 'const {ResumeEngine}=require(' + JSON.stringify(path.join(REPO, 'lib', 'resume-engine.js')) + ');'
    + 'const {HandoffJournal}=require(' + JSON.stringify(path.join(REPO, 'lib', 'handoff-journal.js')) + ');'
    + 'new ResumeEngine({outputDirectory:process.argv[1]},{},process.argv[1]).detectAbortedSession();'
    + 'new HandoffJournal({outputDirectory:process.argv[1]},process.argv[1]).load();process.stdout.write("done")';
  const r = spawnSync(process.execPath, ['-e', script, dir], { encoding: 'utf8', timeout: 8000 });
  assert.equal(r.stdout, 'done', 'returned instead of blocking on the FIFO (' + (r.error ? r.error.code : 'status ' + r.status) + ')');
});

// ---- the update stamp (a HOME file: kind gate + bound, no containment) --------------------------------------------

test('CWK-137: an over-bound update stamp is SKIPPED (the check reads as due), a normal one still throttles', (t) => {
  const home = mk(t, 'ch-cwk137-home-');
  const cwd = project(t);
  const stamp = path.join(home, '.claude', 'coal', 'coalhearth', 'update-check');
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'bin', 'session-start.js')], {
    cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' },
  });
  fs.writeFileSync(stamp, String(Date.now()));
  assert.equal(run().stdout, '', 'a fresh normal stamp throttles (silent)');
  // A fresh timestamp followed by 5 KiB of blanks: an unbounded read trims it back to a valid, fresh stamp (silent);
  // a bounded read skips the over-bound file, so the check is due and nudges.
  fs.writeFileSync(stamp, String(Date.now()) + ' '.repeat(5000));
  assert.match(run().stdout, /self-update due/, 'an over-bound stamp is skipped, so the check is due');
});

// ---- the root wiring, on EVERY OS (the link is pretended, so a Windows box without symlink privilege still proves it) ----
// `file` is a real regular file in the sandbox that lstat/realpath are TOLD is a link resolving to `target`.
function pretendLink(file, target) {
  const real = { lstat: fs.lstatSync, native: fs.realpathSync.native };
  fs.lstatSync = function (p, ...a) {
    const st = real.lstat.call(this, p, ...a);
    return typeof p === 'string' && path.resolve(p) === path.resolve(file)
      ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isSymbolicLink: () => true, isFile: () => false }) : st;
  };
  fs.realpathSync.native = function (p, ...a) {
    return typeof p === 'string' && path.resolve(p) === path.resolve(file) ? target : real.native.call(this, p, ...a);
  };
  return () => { fs.lstatSync = real.lstat; fs.realpathSync.native = real.native; };
}

test('CWK-137 (any OS): AGENTS.md and task.md are read CONTAINED in the workspace -- a link out is refused, a link inside is honored', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Constraints\n- seen\n');
  fs.writeFileSync(path.join(dir, 'task.md'), '## Goal seen\n');
  for (const f of ['AGENTS.md', 'task.md']) {
    const restore = pretendLink(path.join(dir, f), path.join(outside, f));
    try {
      const s = buildStateSnapshot(dir);
      assert.deepEqual(f === 'AGENTS.md' ? s.activePlan.constraints : [s.activePlan.goal], f === 'AGENTS.md' ? [] : [''], f + ' through an escaping link');
    } finally { restore(); }
    const restoreIn = pretendLink(path.join(dir, f), path.join(dir, 'CLAUDE.md'));
    try {
      const s = buildStateSnapshot(dir);
      assert.deepEqual(f === 'AGENTS.md' ? s.activePlan.constraints : [s.activePlan.goal], f === 'AGENTS.md' ? ['seen'] : ['Goal seen'], f + ' through a contained link');
    } finally { restoreIn(); }
  }
});

test('CWK-137 (any OS): the journal is read CONTAINED in its output dir -- a link out is refused, a link inside is honored', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const j = path.join(dir, JOURNAL);
  fs.writeFileSync(j, JSON.stringify({ status: 'in_progress', sessionId: 'seen' }));
  const restore = pretendLink(j, path.join(outside, 'x.json'));
  try {
    assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).load(), null, 'load through an escaping link');
    assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession(), null, 'detect through an escaping link');
    assert.equal(new HandoffJournal({ outputDirectory: dir }, dir)._loadOrQuarantine(), null, 'update path through an escaping link');
  } finally { restore(); }
  const restoreIn = pretendLink(j, path.join(dir, 'real.json'));
  try {
    assert.equal(new ResumeEngine({ outputDirectory: dir }, {}, dir).detectAbortedSession().sessionId, 'seen', 'a contained link is honored');
    assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).load().sessionId, 'seen');
    assert.equal(new HandoffJournal({ outputDirectory: dir }, dir)._loadOrQuarantine().sessionId, 'seen');
  } finally { restoreIn(); }
});

// ---- the journal's temp write (class 2): a link planted at `session_handoff.json.<pid>.tmp` was WRITTEN THROUGH ----------
// The temp name is the pid alone, so it is predictable. A hard link works on any NTFS volume without privilege; the
// symlink variant (what a cloned repo can actually commit) is capability-probed.
const tempOf = (dir, name = JOURNAL) => path.join(dir, name + '.' + process.pid + '.tmp');

test('CWK-137: HandoffJournal.save() never writes THROUGH a hard link planted at its temp name', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'OUTSIDE');
  try { fs.linkSync(victim, tempOf(dir)); } catch { t.skip('hard links not permitted on this volume (' + process.platform + ')'); return; }
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).save({ status: 'in_progress', sessionId: 's1' }), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'the file the temp name was linked to is untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, JOURNAL), 'utf8')).sessionId, 's1', 'the journal itself was written');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp left behind');
});

test('CWK-137: atomicWriteJournal (markResumed, the corrupt quarantine) never writes THROUGH a hard link planted at its temp name', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'OUTSIDE');
  try { fs.linkSync(victim, tempOf(dir)); } catch { t.skip('hard links not permitted on this volume (' + process.platform + ')'); return; }
  assert.equal(atomicWriteJournal(dir, JOURNAL, '{"status":"resumed"}'), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'the linked file is untouched');
  assert.equal(fs.readFileSync(path.join(dir, JOURNAL), 'utf8'), '{"status":"resumed"}');
});

test('CWK-137: a SYMLINK planted at the journal temp name is replaced, never followed (save and atomicWriteJournal)', (t) => {
  const dir = mk(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'OUTSIDE');
  if (!link(victim, tempOf(dir), false)) { t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).save({ status: 'in_progress' }), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'save() did not write through the link');
  assert.ok(link(victim, tempOf(dir, 'other.json'), false));
  assert.equal(atomicWriteJournal(dir, 'other.json', 'NEW'), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'atomicWriteJournal did not write through the link');
});

test('CWK-137 (control): a STALE regular temp left by a crashed holder of the same pid does not break the write', (t) => {
  const dir = mk(t);
  fs.writeFileSync(tempOf(dir), 'stale half-write');
  assert.equal(new HandoffJournal({ outputDirectory: dir }, dir).save({ status: 'in_progress', sessionId: 's2' }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, JOURNAL), 'utf8')).sessionId, 's2');
  fs.writeFileSync(tempOf(dir, 'o.json'), 'stale half-write');
  assert.equal(atomicWriteJournal(dir, 'o.json', 'FRESH'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'o.json'), 'utf8'), 'FRESH');
});

// ---- the legacy-phantom mop-up (class 3): a DELETE through a repo-planted link --------------------------------------
// containedOutputDir's self-clean unlinks `.gitignore` and `session_handoff*` from <cwd>/.claude/coalhearth when the cwd
// is a subdir of the project. That directory is whatever the repo put there: a junction/symlink aimed anywhere made the
// hook unlink those names in the TARGET. Run in a child with its cwd in the subdir, as the hooks run.
function mopUp(sub, home) {
  const script = 'const {containedOutputDir}=require(' + JSON.stringify(path.join(REPO, 'lib', 'contained-dir.js')) + ');process.stdout.write(String(containedOutputDir()))';
  return spawnSync(process.execPath, ['-e', script], {
    cwd: sub, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' },
  });
}

test('CWK-137: the legacy-phantom mop-up never deletes THROUGH a junction/symlink at <cwd>/.claude/coalhearth', (t) => {
  const root = project(t);
  const home = mk(t, 'ch-cwk137-home-');
  const outside = mk(t, 'ch-cwk137-out-');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(path.join(sub, '.claude'), { recursive: true });
  for (const f of ['.gitignore', 'session_handoff.json', 'keep.txt']) fs.writeFileSync(path.join(outside, f), f);
  if (!link(outside, path.join(sub, '.claude', 'coalhearth'), true)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const r = mopUp(sub, home);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['.gitignore', 'session_handoff.json', 'keep.txt']) {
    assert.equal(fs.existsSync(path.join(outside, f)), true, f + ' outside the project is untouched');
  }
});

test('CWK-137: the mop-up never deletes through a link ABOVE the legacy dir either (<cwd>/.claude itself linked out)', (t) => {
  const root = project(t);
  const home = mk(t, 'ch-cwk137-home-');
  const outside = mk(t, 'ch-cwk137-out-');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(outside, 'coalhearth'));
  for (const f of ['.gitignore', 'session_handoff.json']) fs.writeFileSync(path.join(outside, 'coalhearth', f), f);
  if (!link(outside, path.join(sub, '.claude'), true)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  assert.equal(mopUp(sub, home).status, 0);
  for (const f of ['.gitignore', 'session_handoff.json']) {
    assert.equal(fs.existsSync(path.join(outside, 'coalhearth', f)), true, f + ' outside the project is untouched');
  }
});

test('CWK-137 (control): a REAL legacy phantom dir is still mopped up -- only the tool\'s own names, never a foreign file', (t) => {
  const root = project(t);
  const home = mk(t, 'ch-cwk137-home-');
  const sub = path.join(root, 'sub');
  const legacy = path.join(sub, '.claude', 'coalhearth');
  fs.mkdirSync(legacy, { recursive: true });
  for (const f of ['.gitignore', 'session_handoff.json', 'foreign.txt']) fs.writeFileSync(path.join(legacy, f), f);
  assert.equal(mopUp(sub, home).status, 0);
  assert.deepEqual(fs.readdirSync(legacy), ['foreign.txt'], 'own names removed, the foreign file kept, so the dir stays');
  fs.rmSync(path.join(legacy, 'foreign.txt'));
  fs.writeFileSync(path.join(legacy, 'session_handoff.json'), '{}');
  assert.equal(mopUp(sub, home).status, 0);
  assert.equal(fs.existsSync(legacy), false, 'a dir holding only the tool\'s own files is removed');
});

// ---- scripts/configure.mjs: the CLI writer (class 4) ----------------------------------------------------------
const CONFIGURE = path.join(REPO, 'scripts', 'configure.mjs');
// R20 (the same class as CodeRabbit PR #19 thread 20, found by the sweep one file over): a spawned configure.mjs got the parent's environment, so a run that reaches the global
// layer without its own CLAUDE_CONFIG_DIR would read or WRITE the operator's real global config (globalConfigPath honours CLAUDE_CONFIG_DIR, then HOME). The default is now a throwaway
// directory for HOME, USERPROFILE, TEMP, TMP and TMPDIR and a CLAUDE_CONFIG_DIR inside it; a caller's own keys (the --global tests pass theirs; one test overrides PATH) still win.
const CONFIGURE_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-configure-sandbox-'));
after(() => fs.rmSync(CONFIGURE_SANDBOX, { recursive: true, force: true }));
const SANDBOXED_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
function sandboxedEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SANDBOXED_KEYS.includes(k.toUpperCase())) out[k] = v; // Windows names are case-insensitive
  for (const k of SANDBOXED_KEYS) out[k] = k === 'CLAUDE_CONFIG_DIR' ? path.join(CONFIGURE_SANDBOX, '.claude') : CONFIGURE_SANDBOX;
  return { ...out, ...extra };
}
function configure(cwd, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CONFIGURE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { ...sandboxedEnv(extraEnv), NODE_OPTIONS: '--max-old-space-size=2048' },
  });
}
const OWN_CFG = (root) => path.join(root, '.claude', 'coal', 'coalhearth.json');

test('CWK-137: configure never writes THROUGH a directory link at .claude that leads out of the project', (t) => {
  const root = project(t);
  const outside = mk(t, 'ch-cwk137-out-');
  if (!link(outside, path.join(root, '.claude'), true)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const r = configure(root, ['--language', 'th']);
  assert.equal(r.status, 1, 'refused loudly: ' + r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(outside, 'coal')), false, 'nothing was created outside the project');
  assert.doesNotMatch(r.stdout, /Successfully updated/);
  assert.match(r.stderr, /refused to write/i);
  assert.match(r.stderr, /Nothing was written/i, 'says what happened');
  assert.match(r.stderr, /Remove the link/i, 'says what to do next');
});

test('CWK-137 (control): a directory link at .claude that stays INSIDE the project is written through normally', (t) => {
  const root = project(t);
  const inside = path.join(root, 'real-claude');
  fs.mkdirSync(inside);
  if (!link(inside, path.join(root, '.claude'), true)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const r = configure(root, ['--language', 'th']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inside, 'coal', 'coalhearth.json'), 'utf8')).language, 'th');
});

test('CWK-137: configure never writes THROUGH a hard link at the config path -- the entry is replaced, the other name keeps its bytes', (t) => {
  const root = project(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'PRECIOUS');
  fs.mkdirSync(path.dirname(OWN_CFG(root)), { recursive: true });
  try { fs.linkSync(victim, OWN_CFG(root)); } catch { t.skip('hard links not permitted on this volume (' + process.platform + ')'); return; }
  const r = configure(root, ['--language', 'th']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS', 'the file the hard link pointed at is untouched: ' + r.stdout + r.stderr);
});

test('CWK-137: configure never writes the .bak THROUGH a link planted at it (a hard link here; a symlink where permitted)', (t) => {
  const root = project(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'PRECIOUS');
  fs.mkdirSync(path.dirname(OWN_CFG(root)), { recursive: true });
  fs.writeFileSync(OWN_CFG(root), '{ this is not json');
  try { fs.linkSync(victim, OWN_CFG(root) + '.bak'); } catch { t.skip('hard links not permitted on this volume (' + process.platform + ')'); return; }
  configure(root, ['--language', 'th']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS', 'the .bak replaced the link entry, it did not write through it');
  assert.equal(fs.readFileSync(OWN_CFG(root) + '.bak', 'utf8'), '{ this is not json', 'and the backup holds the original bytes');
});

test('CWK-137: a SYMLINK planted at the .bak is replaced, never followed', (t) => {
  const root = project(t);
  const outside = mk(t, 'ch-cwk137-out-');
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'PRECIOUS');
  fs.mkdirSync(path.dirname(OWN_CFG(root)), { recursive: true });
  fs.writeFileSync(OWN_CFG(root), '[1,2]');
  if (!link(victim, OWN_CFG(root) + '.bak', false)) { t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  configure(root, ['--language', 'th']);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS');
  assert.equal(fs.readFileSync(OWN_CFG(root) + '.bak', 'utf8'), '[1,2]');
});

test('CWK-137: an existing project config over MAX_CONFIG_BYTES is REFUSED, untouched -- never read whole, never overwritten', (t) => {
  const root = project(t);
  fs.mkdirSync(path.dirname(OWN_CFG(root)), { recursive: true });
  const body = paddedJson({ journal: { atomicityRetries: 7 } }, MAX_CONFIG_BYTES + 1);
  fs.writeFileSync(OWN_CFG(root), body);
  const r = configure(root, ['--language', 'th']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(OWN_CFG(root), 'utf8'), body, 'byte-exact: nothing was written');
  assert.doesNotMatch(r.stdout, /Successfully updated/);
  assert.match(r.stderr, /cannot be read safely/);
  assert.match(r.stderr, /nothing was written/i);
});

test('CWK-137: an existing GLOBAL config over MAX_CONFIG_BYTES is refused too (bounded, though links are followed there)', (t) => {
  const root = project(t);
  const home = mk(t, 'ch-cwk137-home-');
  const g = path.join(home, '.coalhearth.json');
  const body = paddedJson({ language: 'en' }, MAX_CONFIG_BYTES + 1);
  fs.writeFileSync(g, body);
  const r = configure(root, ['--global', '--language', 'th'], { CLAUDE_CONFIG_DIR: home });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(g, 'utf8'), body);
});

test('CWK-137 (control): a config exactly at MAX_CONFIG_BYTES is still read and rewritten', (t) => {
  const root = project(t);
  fs.mkdirSync(path.dirname(OWN_CFG(root)), { recursive: true });
  fs.writeFileSync(OWN_CFG(root), paddedJson({ journal: { atomicityRetries: 7 } }, MAX_CONFIG_BYTES));
  const r = configure(root, ['--language', 'th']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(fs.readFileSync(OWN_CFG(root), 'utf8'));
  assert.equal(out.language, 'th');
  assert.equal(out.journal.atomicityRetries, 7, 'the sibling key survived the rewrite');
});

test('CWK-137: configure never READS a project config through a directory link that leads out of the project', (t) => {
  const root = project(t);
  const outside = mk(t, 'ch-cwk137-out-');
  fs.mkdirSync(path.join(outside, 'coal'), { recursive: true });
  const planted = JSON.stringify({ language: 'fr' });
  fs.writeFileSync(path.join(outside, 'coal', 'coalhearth.json'), planted);
  if (!link(outside, path.join(root, '.claude'), true)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const r = configure(root, ['--journal.atomicityRetries', '5']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(outside, 'coal', 'coalhearth.json'), 'utf8'), planted, 'the file outside is untouched');
  assert.match(r.stderr, /cannot be read safely \(refused\)/, 'the escaping read is refused, not merged into a rewrite');
});

// R14 FIXBACK (INSPECT LOW-1, M8c): the write guard fails CLOSED on a root it cannot resolve, exactly like its read-side twin.
// configure.mjs always passes an existing root, so the branch is reachable only through a race (the root removed between the
// walk and the write); a unit test is the only thing that holds it.
test('CWK-137: checkRepoWriteTarget refuses (RepoWriteRefused, EREFUSED) when the project root cannot be resolved -- it fails CLOSED', async (t) => {
  const { checkRepoWriteTarget, RepoWriteRefused } = await import('./repo-fs.mjs');
  const base = mk(t);
  const absentRoot = path.join(base, 'no-such-root');
  assert.throws(() => checkRepoWriteTarget(path.join(absentRoot, '.claude', 'coal', 'coalhearth.json'), absentRoot), (e) => {
    assert.ok(e instanceof RepoWriteRefused);
    assert.equal(e.code, 'EREFUSED');
    assert.match(e.message, /cannot be resolved/);
    return true;
  });
  // and the control: an existing root with a target inside it is accepted (the check is not a blanket refusal)
  assert.doesNotThrow(() => checkRepoWriteTarget(path.join(base, '.claude', 'coal', 'coalhearth.json'), base));
});

// R20 (the same sweep): configure() handed the child the parent's HOME, and this file removes CLAUDE_CONFIG_DIR from its own environment, so a --global run that forgot its own
// CLAUDE_CONFIG_DIR fell back to the operator's real home. The parent's HOME stands in for it here, a throwaway directory; the child must never write there.
test('R20: a --global configure run that passes no CLAUDE_CONFIG_DIR never writes under the parent\'s HOME', (t) => {
  const root = project(t);
  const operatorHome = mk(t, 'ch-cwk137-operator-home-');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.HOME = operatorHome;
  process.env.USERPROFILE = operatorHome;
  const r = configure(root, ['--global', '--language', 'th']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(operatorHome), [], 'the operator\'s home was not written');
});

// ---- 08e FIXBACK 2: the same class at the two remaining delete sites -------------------------------------------------------------------------------------------------------------------
// selfCleanLegacyPhantom (lib/contained-dir.js) asked ONE realpath question and then unlinked every matching name and removed the folder; sweepOrphans (lib/resume-engine.js) pinned each
// owned directory ONCE and then deleted many files or worktrees under it. A link swapped in after that one check redirected the deletes into the link's target. Each delete now re-asks the
// pin. The swap is placed by wrapping fs.realpathSync.native for the ONE path the code asks about: it can land right after an answer (the window between a check and the act) or right
// before the Nth answer (so the Nth check is the one that must see it). A directory link is a junction on Windows; a volume that refuses one is a visible skip.
function watchRealpath(target, { swap, swapBefore = 0, swapAfter = 0 }) {
  const real = fs.realpathSync.native;
  const want = path.resolve(target);
  let k = 0;
  let swapped = false;
  fs.realpathSync.native = function (p, ...a) {
    const hit = typeof p === 'string' && path.resolve(p) === want;
    if (hit) { k += 1; if (k === swapBefore) swapped = swap(); }
    const r = real.call(this, p, ...a);
    if (hit && k === swapAfter) swapped = swap();
    return r;
  };
  return { calls: () => k, swapped: () => swapped, restore() { fs.realpathSync.native = real; } };
}
// Replace `dir` by a directory link to `target`; the real folder is moved aside so its own files stay readable.
function swapDirForLink(dir, target) {
  fs.renameSync(dir, dir + '.aside');
  if (link(target, dir, true)) return true;
  fs.renameSync(dir + '.aside', dir);
  return false;
}
function canLinkDirs(t) {
  const d = mk(t, 'ch-fb2-probe-');
  fs.mkdirSync(path.join(d, 'a'));
  const ok = link(path.join(d, 'a'), path.join(d, 'l'), true);
  if (ok) removeLink(path.join(d, 'l'), d, path.join(d, 'a'));
  return ok;
}
const LEGACY_NAMES = ['.gitignore', 'session_handoff.json'];
function phantomFixture(t) {
  const cwd0 = process.cwd();
  t.after(() => process.chdir(cwd0)); // registered FIRST so it runs before the fixture folders are removed (Windows cannot remove the folder a process stands in)
  const root = project(t);
  const sub = path.join(root, 'sub');
  const legacy = path.join(sub, '.claude', 'coalhearth');
  fs.mkdirSync(legacy, { recursive: true });
  for (const f of LEGACY_NAMES) fs.writeFileSync(path.join(legacy, f), f);
  const other = mk(t, 'ch-fb2-other-');
  for (const f of [...LEGACY_NAMES, 'keep.txt']) fs.writeFileSync(path.join(other, f), 'other-' + f);
  const { containedOutputDir } = require('../../lib/contained-dir.js');
  process.chdir(sub);
  return { legacy, other, run: () => containedOutputDir() };
}
const otherSurvives = (other) => ['.gitignore', 'session_handoff.json', 'keep.txt'].every((f) => fs.readFileSync(path.join(other, f), 'utf8') === 'other-' + f);

test('FB2 phantom: a link swapped in right after the one check does not let the unlinks remove the target files', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const { legacy, other, run } = phantomFixture(t);
  const w = watchRealpath(legacy, { swapAfter: 1, swap: () => swapDirForLink(legacy, other) });
  try { run(); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the swap happened');
  assert.ok(otherSurvives(other), 'the files of the swap target are untouched');
});

test('FB2 phantom: a link swapped in between two unlinks stops the later ones (the check is asked per file)', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const { legacy, other, run } = phantomFixture(t);
  const w = watchRealpath(legacy, { swapBefore: 3, swap: () => swapDirForLink(legacy, other) }); // answers: 1 the top check, 2 before the first unlink, 3 before the second
  try { run(); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the third answer was asked, i.e. a check stood before the second unlink');
  assert.ok(otherSurvives(other), 'the files of the swap target are untouched');
});

test('FB2 phantom: the pin is asked before every delete and before the rmdir (top check + one per matching file + one before the rmdir)', (t) => {
  const { legacy, run } = phantomFixture(t);
  const w = watchRealpath(legacy, {});
  try { run(); } finally { w.restore(); }
  assert.equal(w.calls(), 1 + LEGACY_NAMES.length + 1);
  assert.deepEqual(fs.existsSync(legacy), false, 'an ordinary phantom is still mopped and its folder removed');
});

function sweepFixture(t, relDir, names, asDirs) {
  const root = project(t);
  const owned = path.join(root, relDir);
  fs.mkdirSync(owned, { recursive: true });
  for (const n of names) { if (asDirs) fs.mkdirSync(path.join(owned, n)); else fs.writeFileSync(path.join(owned, n), n); }
  const otherRoot = path.join(root, 'otherdir'); // another directory OF THE SAME PROJECT: the per-file containment check cannot tell it from the owned one
  fs.mkdirSync(otherRoot);
  for (const n of [...names, 'keep.mjs']) { if (asDirs && n !== 'keep.mjs') { fs.mkdirSync(path.join(otherRoot, n)); fs.writeFileSync(path.join(otherRoot, n, 'f.txt'), 'x'); } else fs.writeFileSync(path.join(otherRoot, n), n); }
  const e = new ResumeEngine({}, {}, root);
  return { root, owned, otherRoot, run: () => e.sweepOrphans(root) };
}
const SCRATCH_REL = path.join('.claude', 'coalhearth', 'scratch');
const WT_REL = path.join('.claude', 'coalhearth', 'worktrees');

test('FB2 sweep: a link swapped in at the owned scratch dir right after its pin does not let the deletes sweep the target', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const f = sweepFixture(t, SCRATCH_REL, ['probe_a.mjs', 'probe_b.mjs'], false);
  const w = watchRealpath(f.owned, { swapAfter: 1, swap: () => swapDirForLink(f.owned, f.otherRoot) });
  try { f.run(); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the swap happened');
  assert.deepEqual(fs.readdirSync(f.otherRoot).sort(), ['keep.mjs', 'probe_a.mjs', 'probe_b.mjs'], 'nothing was deleted in the swap target');
});

test('FB2 sweep: a link swapped in between two scratch deletes stops the later one (the ownership pin is asked per delete)', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const f = sweepFixture(t, SCRATCH_REL, ['probe_a.mjs', 'probe_b.mjs'], false);
  const w = watchRealpath(f.owned, { swapBefore: 3, swap: () => swapDirForLink(f.owned, f.otherRoot) }); // 1 the first pin, 2 before the first delete, 3 before the second
  try { f.run(); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the third answer was asked, i.e. a pin stood before the second delete');
  assert.deepEqual(fs.readdirSync(f.otherRoot).sort(), ['keep.mjs', 'probe_a.mjs', 'probe_b.mjs'], 'nothing was deleted in the swap target');
});

test('FB2 sweep: the same for the stale worktrees (a recursive delete)', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const f = sweepFixture(t, WT_REL, ['ch-worker-1', 'ch-worker-2'], true);
  const w = watchRealpath(f.owned, { swapBefore: 3, swap: () => swapDirForLink(f.owned, f.otherRoot) });
  try { f.run(); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the third answer was asked, i.e. a pin stood before the second delete');
  assert.deepEqual(fs.readdirSync(f.otherRoot).sort(), ['ch-worker-1', 'ch-worker-2', 'keep.mjs'], 'no worktree was deleted in the swap target');
});

test('FB2 sweep: an ordinary sweep still removes the owned scratch files and worktrees, and asks the pin once per directory plus once per delete', (t) => {
  const f = sweepFixture(t, SCRATCH_REL, ['probe_a.mjs', 'probe_b.mjs'], false);
  const w = watchRealpath(f.owned, {});
  let counts;
  try { counts = f.run(); } finally { w.restore(); }
  assert.equal(counts.scratch, 2);
  assert.equal(w.calls(), 1 + 2, 'the first pin plus one per delete');
  assert.deepEqual(fs.readdirSync(f.owned), []);
});

test('FB2 construct: a link swapped in between the mkdir and the self-ignore write gets no .gitignore, and the journal has no folder', (t) => {
  if (!canLinkDirs(t)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')'); return; }
  const root = project(t);
  const folder = path.join(root, '.claude', 'coalhearth');
  fs.mkdirSync(folder, { recursive: true });
  const other = mk(t, 'ch-fb2-ign-');
  const { containedOutputDir } = require('../../lib/contained-dir.js');
  const w = watchRealpath(folder, { swapBefore: 2, swap: () => swapDirForLink(folder, other) }); // 1 the check before the mkdir, 2 the re-check before the self-ignore write
  let got;
  try { got = containedOutputDir(undefined, root); } finally { w.restore(); }
  assert.ok(w.swapped(), 'the second answer was asked, i.e. a re-check stood between the mkdir and the write');
  assert.equal(got, null, 'fail closed: no journal folder this session');
  assert.deepEqual(fs.readdirSync(other), [], 'no self-ignore file in the swap target');
});

test('FB2 construct (control): an ordinary construction asks twice and still plants the self-ignore file', (t) => {
  const root = project(t);
  const folder = path.join(root, '.claude', 'coalhearth');
  fs.mkdirSync(folder, { recursive: true });
  const { containedOutputDir } = require('../../lib/contained-dir.js');
  const w = watchRealpath(folder, {});
  let got;
  try { got = containedOutputDir(undefined, root); } finally { w.restore(); }
  assert.equal(got, folder);
  assert.equal(w.calls(), 2);
  assert.equal(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8'), '*\n');
});
