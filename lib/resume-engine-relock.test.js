// Run: node --test lib/resume-engine-relock.test.js
// T-29jw-1 and T-29jw-2 (r29qv): a SessionStart act on the journal (the corrupt quarantine's copy and delete, the resume
// mark's write) runs under the journal's own lock, and only when the journal still holds the bytes the detect read. Each leg
// puts another writer's journal (or none, or a folder) in place between the detect read and the act, then reads the endpoints.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeEngine } = require('./resume-engine.js');
const { HandoffJournal } = require('./handoff-journal.js');

const JOURNAL = 'session_handoff.json';
const CORRUPT = 'session_handoff.corrupt.json';
const CORRUPT_BYTES = '{ not json';

// A fresh folder under the OS temp root. t.after removes it only after checking that it resolves under that root.
function fixture(t) {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'coalhearth-relock-')));
  t.after(() => {
    const real = fs.realpathSync(dir);
    if (!real.startsWith(tmpRoot + path.sep)) throw new Error('refusing to remove ' + real + ': it is not under ' + tmpRoot);
    fs.rmSync(real, { recursive: true, force: true });
  });
  return dir;
}

// A valid in-progress journal, as another session's writer would leave it.
function journalText(steps) {
  return JSON.stringify({
    sessionId: 's1',
    status: 'in_progress',
    activePlan: { goal: 'G' },
    checklist: steps.map((task) => ({ task, status: 'todo' })),
    modifiedFiles: [],
  });
}

test('quarantine: a journal another writer put in place after the detect read is neither copied aside nor removed', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  // The detect read saw the corrupt bytes; before the act, another session's valid journal lands at the same name.
  const newer = journalText(['NEW-STEP']);
  fs.writeFileSync(journalPath, newer);
  e._quarantine(journalPath, CORRUPT_BYTES);
  assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), newer, 'the other writer journal survives');
  assert.strictEqual(fs.existsSync(path.join(e.outputDir, CORRUPT)), false, 'no quarantine copy of the stale corrupt bytes');
});

test('quarantine: a journal that vanished after the detect read is not copied aside', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  // The detect read saw the corrupt bytes; before the act, the journal is removed. There is nothing left to quarantine.
  e._quarantine(journalPath, CORRUPT_BYTES);
  assert.strictEqual(fs.existsSync(path.join(e.outputDir, CORRUPT)), false, 'no quarantine copy is written for a journal that is gone');
  assert.strictEqual(fs.existsSync(journalPath), false, 'and nothing is created at the journal name');
});

test('quarantine control: with nothing else writing, the corrupt journal is copied aside and removed, as before', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  fs.writeFileSync(journalPath, CORRUPT_BYTES);
  assert.strictEqual(e.detectAbortedSession(), null, 'a corrupt journal boots clean');
  assert.strictEqual(fs.readFileSync(path.join(e.outputDir, CORRUPT), 'utf8'), CORRUPT_BYTES, 'the bytes are kept aside');
  assert.strictEqual(fs.existsSync(journalPath), false, 'the corrupt journal is removed');
});

test('mark: a journal another writer changed after the detect read is not overwritten by the resume mark', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  fs.writeFileSync(journalPath, journalText(['A']));
  const data = e.detectAbortedSession();
  assert.ok(data, 'the journal reads as an interrupted session');
  // Another session adds a step after the read: the mark must not write its stale copy over that step.
  const newer = journalText(['A', 'B']);
  fs.writeFileSync(journalPath, newer);
  assert.strictEqual(e.markResumed(data), false, 'the mark refuses a journal that changed since the read');
  assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), newer, 'the newer journal, with its step B, is untouched');
});

test('mark: a journal replaced by a folder after the detect read is refused, and the folder is left as it is', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  fs.writeFileSync(journalPath, journalText(['A']));
  const data = e.detectAbortedSession();
  assert.ok(data, 'the journal reads as an interrupted session');
  fs.rmSync(journalPath, { force: true });
  fs.mkdirSync(journalPath);
  assert.strictEqual(e.markResumed(data), false, 'the mark answers false when the journal name is no longer a readable file');
  assert.ok(fs.statSync(journalPath).isDirectory(), 'the folder at the journal name is left as it is');
});

test('mark control: with nothing else writing, the detected journal is marked resumed, and the hook field it adds is kept', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  const journalPath = path.join(e.outputDir, JOURNAL);
  fs.writeFileSync(journalPath, journalText(['A']));
  const data = e.detectAbortedSession();
  assert.ok(data, 'the journal reads as an interrupted session');
  data._orphanSweep = { scratch: 0, worktrees: 0 }; // what the SessionStart hook adds before it marks
  assert.strictEqual(e.markResumed(data), true, 'the mark sticks');
  const back = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(back.status, 'resumed');
  assert.deepStrictEqual(back._orphanSweep, { scratch: 0, worktrees: 0 });
});

test('mark: a fresh journal writer saved after the engine was built is still refused when it differs from the detect read', (t) => {
  const dir = fixture(t);
  const e = new ResumeEngine({ outputDirectory: dir }, {}, dir);
  new HandoffJournal({ outputDirectory: dir }, dir).save({ sessionId: 's1', status: 'in_progress', activePlan: { goal: 'A' }, checklist: [], modifiedFiles: [] });
  const data = e.detectAbortedSession();
  assert.ok(data, 'the saved journal reads as an interrupted session');
  new HandoffJournal({ outputDirectory: dir }, dir).save({ sessionId: 's1', status: 'in_progress', activePlan: { goal: 'A' }, checklist: [{ task: 'B', status: 'todo' }], modifiedFiles: [] });
  assert.strictEqual(e.markResumed(data), false, 'a save after the read makes the mark answer false');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(e.outputDir, JOURNAL), 'utf8')).status, 'in_progress', 'the journal keeps its status');
});
