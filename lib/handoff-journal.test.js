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
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);

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
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);

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
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 }, dir);

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
  const journal = new HandoffJournal({ outputDirectory: dir, atomicityRetries: 2 }, dir);

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

  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
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
  const journal = new HandoffJournal({ outputDirectory: owned, atomicityRetries: 1 }, base);
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
    new HandoffJournal({ outputDirectory: path.join(fileAsDir, 'nested') }, dir);
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

// Regression (audit 2026-07-02 MED, round 2 — REPRODUCED pre-fix): the constructor
// anchored outputDir to the RAW config value, so an untrusted project
// `.coalhearth.json` {"journal":{"outputDirectory":"../victim"}} made save() WRITE
// and _pruneOldLogs DELETE in an arbitrary dir outside the workspace (the round-1
// prune containment only contained within that attacker-supplied dir). The dir is
// now realpath-contained under the workspace root at construction; an escape
// clamps to the default owned dir.
test('an outputDirectory escaping the workspace is clamped: no write, no prune outside', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-hj-clamp-'));
  const workspace = path.join(base, 'workspace');
  const victim = path.join(base, 'victim');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'error.log'), 'victim data');
  fs.writeFileSync(path.join(victim, 'session_handoff.json.tmp'), 'victim tmp');

  const journal = new HandoffJournal({ outputDirectory: path.join('..', 'victim') }, workspace);
  assert.strictEqual(journal.outputDir, path.join(workspace, '.claude', 'coalhearth'), 'escape clamped to the default owned dir');

  assert.strictEqual(journal.save({ status: 'in_progress' }), true, 'save lands in the clamped dir');
  assert.strictEqual(fs.existsSync(path.join(victim, 'session_handoff.json')), false, 'nothing written outside the workspace');
  assert.ok(fs.existsSync(path.join(workspace, '.claude', 'coalhearth', 'session_handoff.json')), 'journal written inside the workspace');

  journal._pruneOldLogs();
  assert.ok(fs.existsSync(path.join(victim, 'error.log')), 'outside error.log NOT deleted');
  assert.ok(fs.existsSync(path.join(victim, 'session_handoff.json.tmp')), 'outside .tmp NOT deleted');

  fs.rmSync(base, { recursive: true, force: true });
});

test('load() round-trips the last save and returns null when nothing was saved', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  assert.strictEqual(journal.load(), null, 'no journal yet -> null');
  journal.save({ status: 'in_progress', modifiedFiles: ['a.js'] });
  const loaded = journal.load();
  assert.strictEqual(loaded.status, 'in_progress');
  assert.deepStrictEqual(loaded.modifiedFiles, ['a.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ROOT 1 / H2 (unit): updateUnderLock quarantines a corrupt prior (never overwrites the
// bytes) and hands the mergeFn null (a fresh start), then saves atomically.
test('updateUnderLock quarantines a corrupt journal and starts fresh, preserving the bytes', () => {
  const dir = tmpDir();
  const jp = path.join(dir, 'session_handoff.json');
  fs.writeFileSync(jp, 'CORRUPT ][');
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const ok = journal.updateUnderLock((prior) => {
    assert.strictEqual(prior, null, 'a corrupt prior reads as null (fresh) — never a throw');
    return { status: 'in_progress', modifiedFiles: ['fresh.js'] };
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(
    fs.readFileSync(path.join(dir, 'session_handoff.corrupt.json'), 'utf8'),
    'CORRUPT ][',
    'the exact corrupt bytes are quarantined, not overwritten'
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')).modifiedFiles, ['fresh.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ROOT 1 (unit): a hostile prior shape that makes the mergeFn throw must never crash the
// hook — updateUnderLock swallows it (fail-silent) and returns false. The lock is released.
test('updateUnderLock is fail-silent when mergeFn throws, and releases the lock', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  let ok;
  assert.doesNotThrow(() => { ok = journal.updateUnderLock(() => { throw new Error('hostile prior'); }); });
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json.lock')), false, 'the lock is released even on a throw');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ROOT 1 (unit): a STALE lock (a crashed holder left it behind) is stolen so the journal
// never freezes; release() removes our lock. (The live-contention serialization is covered
// by the concurrent-writers spawn test in bin/post-tool-use.test.js.)
test('_acquireLock steals a stale lock (crashed holder) and release() removes it', () => {
  const dir = tmpDir();
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const lockPath = path.join(dir, 'session_handoff.json.lock');
  fs.writeFileSync(lockPath, '999999');            // a lock left by "another" (crashed) holder
  const old = new Date(Date.now() - 60_000);        // 60s old -> well past LOCK_STALE_MS
  fs.utimesSync(lockPath, old, old);
  const release = journal._acquireLock();
  assert.ok(fs.existsSync(lockPath), 'the stale lock was stolen and re-acquired');
  release();
  assert.strictEqual(fs.existsSync(lockPath), false, 'release() removes the lock');
  fs.rmSync(dir, { recursive: true, force: true });
});
