// 14a ITEM 1 -- the E2-4 class sweep (a READ or a DELETE through the tool's own project-state folder, <project>/.claude/coalhearth/, that a planted link redirects).
// Run: node --test lib/read-pin.test.js
//
// READ: the journal is written under a folder the clone can plant a link in. Every WRITE and DELETE there asks makePinCheck since v2.8.1/v2.8.2 (SECURITY.md class 6); the three READS
// (HandoffJournal.load, HandoffJournal._loadOrQuarantine, ResumeEngine.detectAbortedSession) did not, and lib/repo-fs.js re-resolves realpath(root) at READ time, so a folder swapped for a
// link aimed OUTSIDE the project made `root` itself the outside directory and the read followed it. detectAbortedSession feeds the SessionStart block the model reads. Each READ test builds
// the object, THEN swaps the folder for a directory link, THEN reads, and asserts the marker text of the file behind the link never comes back.
// DELETE: the orphan sweep and the ENOSPC prune delete entries under the folder; each test plants a link at an ENTRY and asserts the target survives.
// A directory link is a junction on Windows (no privilege) and a symlink elsewhere; a file symlink needs a privilege on Windows, so those legs are probe-keyed (a visible skip).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { HandoffJournal } = require('./handoff-journal');
const { ResumeEngine } = require('./resume-engine');

const HOOK = path.join(__dirname, '..', 'bin', 'session-start.js');
const ENGINE = path.join(__dirname, 'resume-engine.js');
const MARKER = 'OUTSIDE-MARKER-4f7c1a';

const tmp = (label) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-rp-' + label + '-')));

// A project root (a .git marker, so the auto-anchor would accept it) with the real journal folder built by a HandoffJournal, plus an OUTSIDE directory.
function project(t) {
  const root = tmp('root');
  const outside = tmp('out');
  fs.mkdirSync(path.join(root, '.git'));
  t.after(() => {
    for (const p of walkLinks(root)) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* gone */ } } }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return { root, outside };
}

// Every link below `dir` (depth 4), so cleanup unlinks them before any recursive delete.
function walkLinks(dir, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  let names;
  try { names = fs.readdirSync(dir); } catch { return found; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) found.push(p);
    else if (st.isDirectory()) found.push(...walkLinks(p, depth + 1));
  }
  return found;
}

const journalBody = (goal) => JSON.stringify({ status: 'in_progress', sessionId: 's-rp', activePlan: { goal, nextSteps: [], constraints: [] }, checklist: [], modifiedFiles: [] });

// Replace `dir` by a directory link to `target`; false when this volume refuses one.
function swapForLink(dir, target) {
  fs.renameSync(dir, dir + '.aside');
  try {
    fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    fs.renameSync(dir + '.aside', dir);
    return false;
  }
}

function fileLinkOk(t, dir) {
  const probe = path.join(dir, 'probe-file-link');
  const target = path.join(dir, 'probe-file-target');
  fs.writeFileSync(target, 'x');
  try {
    fs.symlinkSync(target, probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    t.skip('file symlink not permitted on this volume (' + process.platform + ')');
    return false;
  } finally {
    fs.rmSync(target, { force: true });
  }
}

// ---- READ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test('READ control: with nothing swapped, load, _loadOrQuarantine and detectAbortedSession all read the real journal', (t) => {
  const { root } = project(t);
  const j = new HandoffJournal({}, root);
  const e = new ResumeEngine({}, {}, root);
  assert.ok(j.outputDir && e.outputDir, 'the folder was built');
  fs.writeFileSync(path.join(j.outputDir, 'session_handoff.json'), journalBody('REAL-GOAL'));
  assert.strictEqual(j.load().activePlan.goal, 'REAL-GOAL');
  assert.strictEqual(j._loadOrQuarantine().activePlan.goal, 'REAL-GOAL');
  assert.strictEqual(e.detectAbortedSession().activePlan.goal, 'REAL-GOAL');
});

for (const aim of ['outside the project', 'another directory of the project']) {
  const where = (root, outside) => (aim === 'outside the project' ? outside : path.join(root, 'src'));
  test('READ: a link swapped in at .claude/coalhearth AFTER construction, aimed at ' + aim + ', returns nothing from load / _loadOrQuarantine / detectAbortedSession', (t) => {
    const { root, outside } = project(t);
    const target = where(root, outside);
    fs.mkdirSync(target, { recursive: true });
    const j = new HandoffJournal({}, root);
    const e = new ResumeEngine({}, {}, root);
    fs.writeFileSync(path.join(target, 'session_handoff.json'), journalBody(MARKER));
    if (!swapForLink(j.outputDir, target)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
    assert.strictEqual(j.load(), null, 'load() must not follow the swapped folder');
    assert.strictEqual(j._loadOrQuarantine(), null, '_loadOrQuarantine() must not follow the swapped folder');
    assert.strictEqual(e.detectAbortedSession(), null, 'detectAbortedSession() must not follow the swapped folder (it feeds the SessionStart block)');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'session_handoff.json'), 'utf8')).status, 'in_progress', 'the file behind the link was not rewritten');
  });
}

test('READ: a CORRUPT journal behind the swapped link is neither read nor quarantined nor deleted (the refused read is not a "corrupt" verdict)', (t) => {
  const { root, outside } = project(t);
  const j = new HandoffJournal({}, root);
  const e = new ResumeEngine({}, {}, root);
  fs.writeFileSync(path.join(outside, 'session_handoff.json'), '{ not json ' + MARKER);
  if (!swapForLink(j.outputDir, outside)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(j._loadOrQuarantine(), null);
  assert.strictEqual(e.detectAbortedSession(), null);
  assert.deepStrictEqual(fs.readdirSync(outside).sort(), ['session_handoff.json'], 'no quarantine copy, and the journal behind the link is still there');
});

test('READ: a CUSTOM output folder (global config) swapped for a link to another place is pinned the same way', (t) => {
  const { root, outside } = project(t);
  const custom = path.join(root, 'custom');
  fs.mkdirSync(custom);
  const j = new HandoffJournal({ outputDirectory: 'custom' }, root);
  const e = new ResumeEngine({ outputDirectory: 'custom' }, {}, root);
  assert.strictEqual(j.outputDir, custom);
  fs.writeFileSync(path.join(outside, 'session_handoff.json'), journalBody(MARKER));
  if (!swapForLink(custom, outside)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(j.load(), null);
  assert.strictEqual(e.detectAbortedSession(), null);
});

test('READ (hook): a link swapped in right before the hook reads the journal prints none of the file behind it, exits 0 and rewrites nothing (the spawned SessionStart hook)', (t) => {
  const { root, outside } = project(t);
  const home = tmp('home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), '{"update":{"updateMode":"off"}}', 'utf8');
  // the real folder exists (a hook run builds it), the swap happens inside the run, between the engine's construction and its first read
  fs.mkdirSync(path.join(root, '.claude', 'coalhearth'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'session_handoff.json'), journalBody(MARKER));
  const preload = path.join(home, 'swap-preload.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const eng = require(process.env.CH_ENGINE);",
    "const orig = eng.ResumeEngine.prototype.detectAbortedSession;",
    "eng.ResumeEngine.prototype.detectAbortedSession = function () {",
    "  const d = this.outputDir;",
    "  fs.renameSync(d, d + '.aside');",
    "  fs.symlinkSync(process.env.CH_OUTSIDE, d, process.platform === 'win32' ? 'junction' : 'dir');",
    "  return orig.call(this);",
    "};",
  ].join('\n'));
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '', CH_ENGINE: ENGINE, CH_OUTSIDE: outside, NODE_OPTIONS: '--require ' + preload.split(path.sep).join('/') },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const stat = fs.lstatSync(path.join(root, '.claude', 'coalhearth'));
  assert.ok(stat.isSymbolicLink(), 'the preload placed the link (the witness is live, not vacuous)');
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'the model-facing output holds none of the file behind the link:\n' + r.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outside, 'session_handoff.json'), 'utf8')).status, 'in_progress', 'the journal behind the link was not marked resumed');
});

test('READ (hook, static): a directory link at .claude/coalhearth from the start prints none of the file behind it and exits 0', (t) => {
  const { root, outside } = project(t);
  const home = tmp('home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), '{"update":{"updateMode":"off"}}', 'utf8');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'session_handoff.json'), journalBody(MARKER));
  try { fs.symlinkSync(outside, path.join(root, '.claude', 'coalhearth'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('directory link not permitted on this volume'); return; }
  const r = spawnSync(process.execPath, [HOOK], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'nothing from the file behind the link:\n' + r.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outside, 'session_handoff.json'), 'utf8')).status, 'in_progress', 'the journal behind the link was not marked resumed');
});

test('READ (hook, static): a file symlink at session_handoff.json aimed outside the project prints none of it and exits 0', (t) => {
  const { root, outside } = project(t);
  const home = tmp('home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), '{"update":{"updateMode":"off"}}', 'utf8');
  if (!fileLinkOk(t, outside)) return;
  const dir = path.join(root, '.claude', 'coalhearth');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(outside, 'journal-elsewhere.json');
  fs.writeFileSync(target, journalBody(MARKER));
  fs.symlinkSync(target, path.join(dir, 'session_handoff.json'), 'file');
  const r = spawnSync(process.execPath, [HOOK], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'nothing from the file behind the link:\n' + r.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).status, 'in_progress', 'the file behind the link was not rewritten');
});

// ---- DELETE --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function sweepRoot(t) {
  const p = project(t);
  const scratch = path.join(p.root, '.claude', 'coalhearth', 'scratch');
  const worktrees = path.join(p.root, '.claude', 'coalhearth', 'worktrees');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(worktrees, { recursive: true });
  const src = path.join(p.root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(p.outside, 'keep-outside.txt'), 'keep-outside');
  return { ...p, scratch, worktrees, src };
}

test('DELETE (sweep): a probe_*.mjs that is a FILE LINK to a project file loses the link and never the target', (t) => {
  const s = sweepRoot(t);
  if (!fileLinkOk(t, s.outside)) return;
  fs.symlinkSync(path.join(s.src, 'keep.txt'), path.join(s.scratch, 'probe_x.mjs'), 'file');
  const out = new ResumeEngine({}, {}, s.root).sweepOrphans(s.root);
  assert.strictEqual(fs.readFileSync(path.join(s.src, 'keep.txt'), 'utf8'), 'keep', 'the target survives');
  assert.strictEqual(fs.existsSync(path.join(s.scratch, 'probe_x.mjs')) && fs.lstatSync(path.join(s.scratch, 'probe_x.mjs')).isSymbolicLink(), false, 'the link itself was the thing removed');
  assert.ok(out.scratch <= 1);
});

test('DELETE (sweep): a probe_*.mjs that is a FILE LINK aimed OUTSIDE the project is left alone and the target survives', (t) => {
  const s = sweepRoot(t);
  if (!fileLinkOk(t, s.outside)) return;
  const target = path.join(s.outside, 'victim.mjs');
  fs.writeFileSync(target, 'victim');
  fs.symlinkSync(target, path.join(s.scratch, 'probe_y.mjs'), 'file');
  new ResumeEngine({}, {}, s.root).sweepOrphans(s.root);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'victim');
});

test('DELETE (sweep): a ch-worker-* that is a DIRECTORY LINK to a project directory loses the link and never the files behind it', (t) => {
  const s = sweepRoot(t);
  try { fs.symlinkSync(s.src, path.join(s.worktrees, 'ch-worker-link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('directory link not permitted on this volume'); return; }
  new ResumeEngine({}, {}, s.root).sweepOrphans(s.root);
  assert.strictEqual(fs.readFileSync(path.join(s.src, 'keep.txt'), 'utf8'), 'keep', 'the files behind the link survive');
});

test('DELETE (sweep): a ch-worker-* that is a DIRECTORY LINK aimed OUTSIDE the project is left alone and the outside files survive', (t) => {
  const s = sweepRoot(t);
  try { fs.symlinkSync(s.outside, path.join(s.worktrees, 'ch-worker-out'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('directory link not permitted on this volume'); return; }
  new ResumeEngine({}, {}, s.root).sweepOrphans(s.root);
  assert.strictEqual(fs.readFileSync(path.join(s.outside, 'keep-outside.txt'), 'utf8'), 'keep-outside');
});

test('DELETE (sweep): a REAL ch-worker-* directory holding a link that leads OUTSIDE the project is removed without deleting through the link (recursive rmSync unlinks a link, it does not follow it)', (t) => {
  const s = sweepRoot(t);
  const wt = path.join(s.worktrees, 'ch-worker-real');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'own.txt'), 'own');
  try { fs.symlinkSync(s.outside, path.join(wt, 'inner-link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('directory link not permitted on this volume'); return; }
  const out = new ResumeEngine({}, {}, s.root).sweepOrphans(s.root);
  assert.strictEqual(fs.existsSync(wt), false, 'the worker directory is gone (control: the sweep ran)');
  assert.strictEqual(out.worktrees, 1);
  assert.strictEqual(fs.readFileSync(path.join(s.outside, 'keep-outside.txt'), 'utf8'), 'keep-outside', 'the files behind the inner link survive');
});

test('DELETE (prune): a *.tmp that is a FILE LINK aimed outside the project, and one aimed at a project file, never lose their targets (the ENOSPC prune)', (t) => {
  const s = sweepRoot(t);
  if (!fileLinkOk(t, s.outside)) return;
  const j = new HandoffJournal({}, s.root);
  const victimOut = path.join(s.outside, 'victim.txt');
  fs.writeFileSync(victimOut, 'victim');
  fs.symlinkSync(victimOut, path.join(j.outputDir, 'a.tmp'), 'file');
  fs.symlinkSync(path.join(s.src, 'keep.txt'), path.join(j.outputDir, 'b.tmp'), 'file');
  j._pruneOldLogs();
  assert.strictEqual(fs.readFileSync(victimOut, 'utf8'), 'victim');
  assert.strictEqual(fs.readFileSync(path.join(s.src, 'keep.txt'), 'utf8'), 'keep');
});

test('DELETE (prune): a link swapped in at the folder AFTER the prune started cannot redirect it (the prune works on the physical path it resolved)', (t) => {
  const s = sweepRoot(t);
  const j = new HandoffJournal({}, s.root);
  fs.writeFileSync(path.join(j.outputDir, 'junk.tmp'), 'junk');
  fs.writeFileSync(path.join(s.outside, 'other.tmp'), 'other');
  const physical = fs.realpathSync.native(j.outputDir);
  const realReaddir = fs.readdirSync;
  let swapped = true;
  fs.readdirSync = function patched(p, ...rest) { // the swap lands right after the prune resolved and listed its folder
    const names = realReaddir.call(fs, p, ...rest);
    if (p === physical) { fs.readdirSync = realReaddir; swapped = swapForLink(j.outputDir, s.outside); }
    return names;
  };
  t.after(() => { fs.readdirSync = realReaddir; });
  j._pruneOldLogs();
  if (!swapped) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(fs.readFileSync(path.join(s.outside, 'other.tmp'), 'utf8'), 'other', 'the file in the swap target survives');
});
