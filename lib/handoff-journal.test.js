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
  // CWK-120 #8: save() writes `session_handoff.json.<pid>.tmp`, so the old literal-name check (`.json.tmp`) was true
  // whatever save() did and could never see a leftover. Scan the directory for ANY *.tmp instead.
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind');

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
// 05a FIXBACK 1: the prune deletes only inside the LITERAL owned folder (<root>/.claude/coalhearth), so this test now works there; it used to point outputDirectory at the root itself, a custom directory the prune no longer touches.
  const root = tmpDir();
  const dir = path.join(root, '.claude', 'coalhearth');
  const journal = new HandoffJournal({ atomicityRetries: 2 }, root);
  assert.strictEqual(journal.outputDir, dir);
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale\n');

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

  fs.rmSync(root, { recursive: true, force: true });
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
// 05a FIXBACK 1: the prune deletes only inside the LITERAL owned folder (<root>/.claude/coalhearth), so this test now works there; it used to point outputDirectory at the root itself, a custom directory the prune no longer touches.
  const root = tmpDir();
  const dir = path.join(root, '.claude', 'coalhearth');
  const journal = new HandoffJournal({}, root);
  assert.strictEqual(journal.outputDir, dir);
  fs.writeFileSync(path.join(dir, 'error.log'), 'stale');
  fs.writeFileSync(path.join(dir, 'session_handoff.json.tmp'), 'leftover');
  fs.writeFileSync(path.join(dir, 'session_handoff.corrupt.json'), '{forensic}');
  fs.writeFileSync(path.join(dir, 'session_handoff.json'), '{}');
  fs.writeFileSync(path.join(dir, 'user-notes.md'), 'not ours'); // unrecognized -> KEEP

  journal._pruneOldLogs();

  assert.strictEqual(fs.existsSync(path.join(dir, 'error.log')), false, 'error.log pruned');
  assert.strictEqual(fs.existsSync(path.join(dir, 'session_handoff.json.tmp')), false, '.tmp pruned');
  assert.ok(fs.existsSync(path.join(dir, 'session_handoff.json')), 'journal kept');
  assert.ok(fs.existsSync(path.join(dir, 'session_handoff.corrupt.json')), 'corrupt quarantine kept (was blind-deleted before)');
  assert.ok(fs.existsSync(path.join(dir, 'user-notes.md')), 'unrecognized non-junk file kept');

  fs.rmSync(root, { recursive: true, force: true });
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

// board #142/U11-B1: a losing `wx`-create race can surface as EPERM on Windows, not
// EEXIST (found by instrumenting the real concurrent-writers spawn test — one of 10
// writers logged `unlockable code=EPERM` on its FIRST attempt, then bailed lock-free
// with none of the wait/retry/steal logic ever running). The real OS race is
// environment-dependent (testing.md Determinism: inject the failure, don't chase real
// timing) -- so this pins the ERRNO CLASSIFICATION directly: a single injected EPERM
// on the first `wx` attempt must be treated as contention (poll + retry), never as a
// permanent "unlockable" bail-out. RED-PROOF: revert _acquireLock's `contended` check
// back to `err.code !== 'EEXIST'` alone and this goes red (calls stays 1, no lock).
test('_acquireLock treats an injected EPERM on wx-create as contention, not a permanent failure', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // scripts-quality.md: clean on both the pass and fail path
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const lockPath = path.join(dir, 'session_handoff.json.lock');
  const realWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (p, data, opts) => {
    if (p === lockPath && opts && opts.flag === 'wx' && calls++ === 0) {
      const err = new Error('EPERM: operation not permitted, open');
      err.code = 'EPERM';
      throw err;
    }
    return realWrite(p, data, opts);
  };
  try {
    const release = journal._acquireLock();
    assert.strictEqual(calls, 2, 'the injected EPERM on attempt 1 did not stop a second wx attempt from running');
    assert.ok(fs.existsSync(lockPath), 'the lock was genuinely acquired on retry, not abandoned as lock-free');
    release();
  } finally {
    fs.writeFileSync = realWrite;
  }
});

// Negative control for the same fix: a genuinely unrecoverable error (neither EEXIST nor
// EPERM — e.g. a real permissions/disk failure) must still bail lock-free on the FIRST
// attempt. Widening the contended-error set to EPERM must not swallow every error code.
test('_acquireLock still bails lock-free immediately on a non-contention error (e.g. EACCES)', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // scripts-quality.md: clean on both the pass and fail path
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const lockPath = path.join(dir, 'session_handoff.json.lock');
  const realWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (p, data, opts) => {
    if (p === lockPath && opts && opts.flag === 'wx') {
      calls++;
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return realWrite(p, data, opts);
  };
  try {
    const release = journal._acquireLock();
    assert.strictEqual(calls, 1, 'a genuinely unrecoverable error bails after exactly one attempt, never retried');
    assert.strictEqual(fs.existsSync(lockPath), false, 'no lock was created');
    release(); // the returned noop must still be safely callable
  } finally {
    fs.writeFileSync = realWrite;
  }
});

// CWK-120 finding #1 (CodeRabbit, Major): when wx-create says EEXIST and fs.statSync(lockPath) THEN throws, the code
// ran `continue` with no deadline check and no sleep -- if the stat error persists (a lock another process holds open
// exclusively on Windows can surface as EPERM/EBUSY on stat while the wx create still says EEXIST) the loop spun at
// full CPU FOREVER, in a synchronous hook, instead of degrading to the documented lock-free best-effort path.
// The claim is TRUE at the live tree. Only ENOENT (the lock vanished between the two calls) is worth an immediate
// retry; every other stat/steal failure now falls into the same bounded poll as every other contention branch.
// R19 (CodeRabbit [11]): the two assertions below used to read the wall clock (`waited >= 400`, `Date.now() - t0 < 400`), so they
// depended on scheduler timing and on Atomics.wait sleeping at least its argument. The poll is observed through its SLEEP SEAM
// instead: `journal._sleepSync` is stubbed, counted, and made to advance a fake `Date.now`, so the bounded wait and the immediate
// ENOENT retry are both decided by counts, never by elapsed real time. The fake clock is installed only around `_acquireLock`.
function fakeClock(journal) {
  const realNow = Date.now;
  let now = realNow.call(Date);
  const sleeps = [];
  journal._sleepSync = (ms) => { sleeps.push(ms); now += ms; };
  Date.now = () => now;
  return { sleeps, restore() { Date.now = realNow; } };
}

// SAFETY VALVE: the patched stat removes the lock after SPIN_CAP calls, so a REGRESSION fails the assertion instead
// of hanging the suite.
test('_acquireLock stays inside its bounded wait when stat of a HELD lock keeps failing (EPERM), then proceeds lock-free', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const lockPath = path.join(dir, 'session_handoff.json.lock');
  fs.writeFileSync(lockPath, '1'); // held by "another" process: every wx create says EEXIST
  const realStat = fs.statSync;
  const SPIN_CAP = 5000;
  let stats = 0;
  fs.statSync = (p, ...rest) => {
    if (p === lockPath) {
      if (++stats >= SPIN_CAP) fs.rmSync(lockPath, { force: true });
      const err = new Error('EPERM: operation not permitted, stat');
      err.code = 'EPERM';
      throw err;
    }
    return realStat(p, ...rest);
  };
  const clock = fakeClock(journal);
  let release;
  try {
    release = journal._acquireLock();
  } finally {
    fs.statSync = realStat;
    clock.restore();
  }
  const slept = clock.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(stats < SPIN_CAP, 'the loop must not spin on a persistent stat failure (stat calls: ' + stats + ')');
  assert.ok(stats <= 200, 'bounded by LOCK_WAIT_MS / LOCK_POLL_MS polls (stat calls: ' + stats + ')');
  assert.ok(clock.sleeps.length >= 1, 'it polled (slept) at least once instead of bailing at once');
  assert.ok(slept >= 500, 'it waited the whole bounded window (LOCK_WAIT_MS = 500) on the sleep seam before giving up (slept ' + slept + ' ms in ' + clock.sleeps.length + ' sleeps)');
  assert.ok(fs.existsSync(lockPath), 'lock-free: the other holder lock is left alone');
  release();
  assert.ok(fs.existsSync(lockPath), 'the returned noop never removes a lock it does not own');
});

test('_acquireLock still retries AT ONCE when the held lock vanishes between the create and the stat (ENOENT)', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = new HandoffJournal({ outputDirectory: dir }, dir);
  const lockPath = path.join(dir, 'session_handoff.json.lock');
  fs.writeFileSync(lockPath, '1');
  const realStat = fs.statSync;
  let stats = 0;
  fs.statSync = (p, ...rest) => {
    if (p === lockPath && stats++ === 0) {
      fs.rmSync(lockPath, { force: true }); // the holder released between our wx and our stat
      const err = new Error('ENOENT: no such file or directory, stat');
      err.code = 'ENOENT';
      throw err;
    }
    return realStat(p, ...rest);
  };
  const clock = fakeClock(journal);
  let release;
  try {
    release = journal._acquireLock();
  } finally {
    fs.statSync = realStat;
    clock.restore();
  }
  assert.deepStrictEqual(clock.sleeps, [], 'an ENOENT retry does not poll: the sleep seam was never called');
  assert.ok(fs.existsSync(lockPath), 'the lock was genuinely acquired on the immediate retry');
  release();
  assert.strictEqual(fs.existsSync(lockPath), false);
});

// ---- 08c unit 2, LOW-A: the pin on the output folder is re-checked at every write, not only when the journal is built --------------------------------------------------------------
// SECURITY.md class 6 / CHANGELOG [2.6.3] "Not covered": a link swapped in at <root>/.claude/coalhearth between containedOutputDir's check (construction) and the write redirected that
// run's write (the reviewer's scratchpad/r05a/insp/attack.mjs case F). Each test builds the journal, THEN swaps the folder for a directory link, THEN writes, and asserts the positive
// state effect: nothing lands in the link's target. A directory link is a junction on Windows (no privilege) and a symlink elsewhere; a volume that refuses one is a visible skip.
const { ResumeEngine } = require('./resume-engine');

function rootWithLinkTools(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-lowa-')));
  t.after(() => {
    for (const p of [path.join(root, '.claude', 'coalhearth'), path.join(root, 'custom')]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } } } catch { /* absent */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// Replace `dir` by a directory link to `target`. Returns false (and leaves a visible skip to the caller) when this volume refuses a directory link.
function swapForLink(dir, target) {
  const aside = dir + '.aside';
  fs.renameSync(dir, aside);
  try {
    fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    fs.renameSync(aside, dir);
    return false;
  }
}

const noFilesIn = (d) => fs.readdirSync(d).filter((n) => /session_handoff|\.lock|\.tmp|corrupt/.test(n));

test('LOW-A: a link swapped in at the default folder AFTER construction receives no journal write (save), and the swap target stays empty', (t) => {
  const root = rootWithLinkTools(t);
  const target = path.join(root, 'src'); // another directory OF THE PROJECT: inside the root, so the construction-time containment check could never have refused it
  fs.mkdirSync(target);
  const j = new HandoffJournal({}, root);
  assert.strictEqual(j.outputDir, path.join(root, '.claude', 'coalhearth'));
  assert.strictEqual(j.save({ status: 'in_progress' }), true, 'control: before the swap the write lands');
  if (!swapForLink(j.outputDir, target)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(j.save({ status: 'in_progress', modifiedFiles: ['x'] }), false, 'the pin no longer holds, so the write is refused');
  assert.deepStrictEqual(noFilesIn(target), [], 'nothing lands in the swap target');
});

test('LOW-A: the same swap aimed OUTSIDE the project root is refused too, through updateUnderLock (the hook path: lock, load, save)', (t) => {
  const root = rootWithLinkTools(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-lowa-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const j = new HandoffJournal({}, root);
  if (!swapForLink(j.outputDir, outside)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(j.updateUnderLock(() => ({ status: 'in_progress' })), false);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'no journal, no lock file, no temp file in the outside folder');
});

test('LOW-A: the lock file and the corrupt-journal quarantine copy are guarded by the same pin', (t) => {
  const root = rootWithLinkTools(t);
  const target = path.join(root, 'src');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'session_handoff.json'), '{ not json'); // a corrupt journal waiting in the swap target, so a load through the link would quarantine it
  const j = new HandoffJournal({}, root);
  if (!swapForLink(j.outputDir, target)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  const release = j._acquireLock();
  const lockSeen = fs.readdirSync(target).filter((n) => n.endsWith('.lock')); // read BEFORE release(), which would remove a lock written through the link
  release();
  assert.deepStrictEqual(lockSeen, [], 'no lock file written through the link');
  j._loadOrQuarantine();
  assert.deepStrictEqual(fs.readdirSync(target).filter((n) => /corrupt|\.tmp/.test(n)), [], 'no quarantine copy written through the link');
});

test('LOW-A: a CUSTOM output folder (global config) is pinned too: swapped for a link to another place, the write is refused', (t) => {
  const root = rootWithLinkTools(t);
  const custom = path.join(root, 'custom');
  const target = path.join(root, 'src');
  fs.mkdirSync(target);
  const j = new HandoffJournal({ outputDirectory: 'custom' }, root);
  assert.strictEqual(j.outputDir, custom);
  assert.strictEqual(j.save({ status: 'in_progress' }), true, 'control');
  if (!swapForLink(custom, target)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(j.save({ status: 'in_progress' }), false);
  assert.deepStrictEqual(noFilesIn(target), []);
});

test('LOW-A: the resume engine pins its writes (markResumed, the corrupt quarantine) the same way, and a refused quarantine does not DELETE the journal either', (t) => {
  const root = rootWithLinkTools(t);
  const target = path.join(root, 'src');
  fs.mkdirSync(target);
  const journalInTarget = path.join(target, 'session_handoff.json');
  fs.writeFileSync(journalInTarget, '{ not json'); // reached through the link after the swap: a quarantine that ran would copy it aside and then remove it
  const e = new ResumeEngine({}, {}, root);
  if (!swapForLink(e.outputDir, target)) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(e.markResumed({ sessionId: 's', status: 'in_progress' }), false);
  assert.strictEqual(fs.readFileSync(journalInTarget, 'utf8'), '{ not json', 'markResumed did not rewrite the file in the swap target');
  e._quarantine(path.join(e.outputDir, 'session_handoff.json'), '{ not json');
  assert.deepStrictEqual(fs.readdirSync(target), ['session_handoff.json'], 'no quarantine copy, and the journal in the swap target was not removed');
});

test('LOW-A: an ordinary run is unchanged -- save, updateUnderLock, quarantine and markResumed all still land when nothing was swapped', (t) => {
  const root = rootWithLinkTools(t);
  const j = new HandoffJournal({}, root);
  assert.strictEqual(j.save({ status: 'in_progress' }), true);
  assert.strictEqual(j.updateUnderLock((p) => ({ ...p, status: 'in_progress', modifiedFiles: ['a'] })), true);
  assert.deepStrictEqual(j.load().modifiedFiles, ['a']);
  const e = new ResumeEngine({}, {}, root);
  assert.strictEqual(e.markResumed(j.load()), true);
  fs.writeFileSync(path.join(j.outputDir, 'session_handoff.json'), '{ not json');
  assert.strictEqual(j._loadOrQuarantine(), null);
  assert.ok(fs.existsSync(path.join(j.outputDir, 'session_handoff.corrupt.json')), 'the quarantine copy is written');
});

// ---- 08c unit 2 FIXBACK 1 (INSPECT LOW-1): the lock file is pinned on every path that touches it, not only at the acquire ------------------------------------------------------------
// The reviewer's pinattack.js case1: a swap made while the lock is held (mergeFn runs between the acquire and the save) used to leave the release deleting
// session_handoff.json.lock in the link's TARGET, e.g. another project's live lock. The poll loop and the stale-lock steal are the same class.
test('LOCK PIN: a swap made while the lock is held does not let the release delete a lock file in the link target (INSPECT LOW-1 witness)', (t) => {
  const root = rootWithLinkTools(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-lockpin-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'session_handoff.json.lock'), '99999'); // another project's live lock
  const j = new HandoffJournal({}, root);
  assert.strictEqual(j.save({ status: 'in_progress' }), true);
  let swapped = true;
  const r = j.updateUnderLock((prior) => {
    swapped = swapForLink(j.outputDir, other);
    return { ...prior, status: 'in_progress' };
  });
  if (!swapped) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  assert.strictEqual(r, false, 'the save refuses on the pin');
  assert.strictEqual(fs.readFileSync(path.join(other, 'session_handoff.json.lock'), 'utf8'), '99999', 'the other project lock is still there, untouched');
  assert.deepStrictEqual(fs.readdirSync(other), ['session_handoff.json.lock']);
});

test('LOCK PIN: a swap made while the acquire is polling for a held lock does not let a later create write a lock file in the link target', (t) => {
  const root = rootWithLinkTools(t);
  const target = path.join(root, 'src');
  fs.mkdirSync(target);
  const j = new HandoffJournal({}, root);
  fs.writeFileSync(path.join(j.outputDir, 'session_handoff.json.lock'), String(process.pid)); // a fresh lock held by "someone else": the acquire polls
  let swapped = true;
  j._sleepSync = () => { swapped = swapForLink(j.outputDir, target); }; // the swap lands during the first poll sleep
  const release = j._acquireLock();
  if (!swapped) { t.skip('directory link not permitted on this volume (' + process.platform + ')'); return; }
  const seen = fs.readdirSync(target); // BEFORE release(), which would remove a lock written through the link
  release();
  assert.deepStrictEqual(seen, [], 'no lock file created in the link target by a later iteration');
});

test('LOCK PIN: the stale-lock steal asks the pin first, so a folder that stopped being pinned loses nothing', (t) => {
  const root = rootWithLinkTools(t);
  const j = new HandoffJournal({}, root);
  const lockPath = path.join(j.outputDir, 'session_handoff.json.lock');
  fs.writeFileSync(lockPath, '1');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lockPath, old, old); // stale: the steal would remove it
  let calls = 0;
  j._pinned = () => ++calls === 1; // pinned at the top of the first iteration, not any more when the steal is about to run
  const release = j._acquireLock();
  release();
  assert.ok(fs.existsSync(lockPath), 'the stale lock was not removed once the pin stopped holding');
});

test('LOCK PIN: an ordinary acquire, release and steal still work with the pin held', (t) => {
  const root = rootWithLinkTools(t);
  const j = new HandoffJournal({}, root);
  const lockPath = path.join(j.outputDir, 'session_handoff.json.lock');
  const lockListed = () => fs.readdirSync(j.outputDir).includes('session_handoff.json.lock'); // a folder listing, not a check of lockPath itself (CodeQL js/file-system-race, alert 22)
  const release = j._acquireLock();
  assert.ok(lockListed(), 'acquired');
  release();
  assert.ok(!lockListed(), 'released');
  fs.writeFileSync(lockPath, '1');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lockPath, old, old);
  const release2 = j._acquireLock();
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), String(process.pid), 'a stale lock is stolen and re-taken');
  release2();
});
