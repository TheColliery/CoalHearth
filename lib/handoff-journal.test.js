// Run: node --test lib/handoff-journal.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { HandoffJournal } = require('./handoff-journal');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-hj-'));
}

test('save() writes session_handoff.json atomically and returns true', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir });

  const ok = journal.save({ status: 'in_progress', checklist: [], modifiedFiles: [] });

  assert.strictEqual(ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'session_handoff.json'), 'utf8'));
  assert.strictEqual(written.status, 'in_progress');
  assert.ok(written.timestamp);
  assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json.tmp')), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('save() is fail-silent on unserializable state (circular ref)', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir });

  const circular = {};
  circular.self = circular;

  assert.doesNotThrow(() => {
    const ok = journal.save(circular);
    assert.strictEqual(ok, false);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('save() prunes non-journal files on ENOSPC and keeps retrying within bound', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale\n');
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 });

  // Simulate ENOSPC on first writeFileSync call only.
  const realWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...args) => {
    calls++;
    if (calls === 1) {
      const err = new Error('no space');
      err.code = 'ENOSPC';
      throw err;
    }
    return realWrite(...args);
  };

  let ok;
  try {
    ok = journal.save({ status: 'in_progress' });
  } finally {
    fs.writeFileSync = realWrite;
  }

  assert.strictEqual(ok, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'error.log')), false, 'pruned on ENOSPC');
  assert.ok(fs.existsSync(path.join(dir, 'session_handoff.json')), 'core json kept');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('save() returns false (fail-silent) after exhausting retries on a persistent error', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 });

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    const err = new Error('busy');
    err.code = 'EBUSY';
    throw err;
  };

  let ok;
  try {
    assert.doesNotThrow(() => {
      ok = journal.save({ status: 'in_progress' });
    });
  } finally {
    fs.writeFileSync = realWrite;
  }

  assert.strictEqual(ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression (audit 2026-07-02 HIGH): the ENOSPC prune must NOT blind-delete. It is
// an allow-list (error.log + *.tmp) that KEEPS the journal AND the *.corrupt.json
// forensic quarantine, and realpath-contains to the owned journal dir so an untrusted
// `.coalhearth.json` cannot aim it at a foreign tree.
test('_pruneOldLogs keeps the corrupt quarantine + non-junk, drops only owned transient junk', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale');
  fs.writeFileSync(path.join(dir, 'session_handoff.json.tmp'), 'leftover');
  fs.writeFileSync(path.join(dir, 'session_handoff.corrupt.json'), '{forensic}');
  fs.writeFileSync(path.join(dir, 'session_handoff.json'), '{}');
  fs.writeFileSync(path.join(dir, 'user-notes.md'), 'not ours'); // unrecognized -> KEEP

  const journal = new HandoffJournal({ outputDirectory: dir });
  journal._pruneOldLogs();

  assert.strictEqual(fs.existsSync(path.join(dir, 'error.log')), false, 'error.log pruned');
  assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json.tmp')), false, '.tmp pruned');
  assert.ok(fs.existsSync(path.join(dir, 'session_handoff.json')), 'journal kept');
  assert.ok(fs.existsSync(path.join(dir, 'session_handoff.corrupt.json')), 'corrupt quarantine kept (was blind-deleted before)');
  assert.ok(fs.existsSync(path.join(dir, 'user-notes.md')), 'unrecognized non-junk file kept');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('_pruneOldLogs (ENOSPC) never deletes files in a dir OUTSIDE the owned journal dir', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-hj-esc-'));
  const owned = path.join(base, 'owned');
  const outside = path.join(base, 'secrets');
  fs.mkdirSync(owned, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // Prunable-NAMED files in the outside dir: they must survive because they are not
  // inside realpath(outputDir). A blind readdir of a traversal target would nuke them.
  fs.writeFileSync(path.join(outside, 'error.log'), 'attacker cannot delete this');
  fs.writeFileSync(path.join(outside, 'session_handoff.json.tmp'), 'nor this');

  // Untrusted config points the journal at `owned`, then forces the ENOSPC prune path.
  const journal = new HandoffJournal({ outputDirectory: owned, atomicityRetries: 1 });
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };
  try {
    assert.doesNotThrow(() => journal.save({ status: 'in_progress' })); // ENOSPC -> _pruneOldLogs
  } finally {
    fs.writeFileSync = realWrite;
  }

  assert.ok(fs.existsSync(path.join(outside, 'error.log')), 'outside error.log NOT deleted');
  assert.ok(fs.existsSync(path.join(outside, 'session_handoff.json.tmp')), 'outside .tmp NOT deleted');

  fs.rmSync(base, { recursive: true, force: true });
});

test('constructor never throws even if outputDir cannot be created', () => {
  // Point at a path that collides with an existing file segment.
  const dir = tmpDir();
  const fileAsDir = path.join(dir, 'blocker');
  fs.writeFileSync(fileAsDir, 'x');

  assert.doesNotThrow(() => {
    new HandoffJournal({ outputDirectory: path.join(fileAsDir, 'nested') });
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
