// Run: node --test lib/handoff-lock.test.js
// The journal lock gives up at its deadline. A link at the lock name that points nowhere makes the create report an existing entry
// while the stat reports nothing there; the retry for that case used to run at once, with no deadline check, so the save spun
// until the host killed the hook. The save now returns within its bound, lock-free, and exits 0.
//
// Two legs. The link leg plants a real dangling link, and it runs only where the link gives the pair the retry spins on (a create
// that reports EEXIST and a stat that reports ENOENT); elsewhere it skips, visibly, with the codes it saw. The injected leg makes the
// same two calls report that pair inside the child, so the branch is exercised on every host, Windows included.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const JOURNAL_MODULE = path.join(__dirname, 'handoff-journal.js');
const LOCK_NAME = 'session_handoff.json.lock';
const KILL_MS = 10000; // the child is killed past this: a spin would hit it
const BOUND_MS = 3000; // the save must return well inside this

function tmpDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-lock-')));
}

// A link at `at` that points at a folder which does not exist. A junction needs no privilege on Windows: make the target,
// link to it, then remove the target, which leaves a dangling junction. Returns false when no such link can be made here.
function danglingLinkAt(at, target) {
  try {
    if (process.platform === 'win32') {
      fs.mkdirSync(target);
      fs.symlinkSync(target, at, 'junction');
      fs.rmdirSync(target);
    } else {
      fs.symlinkSync(target, at);
    }
    return fs.lstatSync(at).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

// What the lock's two calls report at `at`: the exclusive create (its code, or 'ok') and the stat (its code, or 'ok').
function codesAt(at) {
  let create = 'ok';
  try { fs.writeFileSync(at, 'probe', { flag: 'wx' }); } catch (e) { create = e.code; }
  let stat = 'ok';
  try { fs.statSync(at); } catch (e) { stat = e.code; }
  return { create, stat };
}

// Runs the journal save in a child with a kill timeout; returns the result and the elapsed time.
function saveInChild(dir, preload) {
  const child = `
    ${preload}
    const { HandoffJournal } = require(process.argv[1]);
    const dir = process.argv[2];
    new HandoffJournal({ outputDirectory: dir }, dir).updateUnderLock(() => ({ status: 'in_progress', checklist: [], modifiedFiles: [] }));
    process.exitCode = 0;
  `;
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ['-e', child, JOURNAL_MODULE, dir], { encoding: 'utf8', timeout: KILL_MS });
  return { res, elapsed: Date.now() - t0 };
}

function assertReturnedWithinBound({ res, elapsed }) {
  assert.ok(!res.error, `the child did not run: ${res.error && res.error.code}`);
  assert.strictEqual(res.signal, null, `the child was killed at ${KILL_MS} ms (the lock retry spun): signal ${res.signal}`);
  assert.strictEqual(res.status, 0, `the child exits 0, got ${res.status}: ${res.stderr}`);
  assert.ok(elapsed < BOUND_MS, `the save took ${elapsed} ms, bound ${BOUND_MS} ms`);
}

test('a save with a dangling link at the lock name returns within its bound and exits 0', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = path.join(dir, 'probe.lock');
  if (!danglingLinkAt(probe, path.join(dir, 'probe-target'))) {
    t.skip('this volume will not make a dangling link here (no junction or symlink)');
    return;
  }
  const seen = codesAt(probe);
  if (!(seen.create === 'EEXIST' && seen.stat === 'ENOENT')) {
    t.skip(`a dangling link here gives create ${seen.create} and stat ${seen.stat}, not the EEXIST and ENOENT pair the retry spins on`);
    return;
  }
  const lock = path.join(dir, LOCK_NAME);
  assert.ok(danglingLinkAt(lock, path.join(dir, 'gone-target')), 'the dangling link at the lock name is planted');
  assertReturnedWithinBound(saveInChild(dir, ''));
});

test('a save whose lock reports an existing entry that cannot be stat\'d returns within its bound and exits 0', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, LOCK_NAME);
  // The same two answers a dangling link gives, injected for the lock path only in the child: the create reports EEXIST and the stat
  // reports ENOENT. Every other call goes to the real fs.
  const preload = `
    const fs = require('node:fs');
    const LOCK = process.argv[3];
    const realWrite = fs.writeFileSync, realStat = fs.statSync;
    fs.writeFileSync = function (p, ...rest) {
      if (String(p) === LOCK) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
      return realWrite.call(fs, p, ...rest);
    };
    fs.statSync = function (p, ...rest) {
      if (String(p) === LOCK) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return realStat.call(fs, p, ...rest);
    };
  `;
  const child = saveInChild(dir, preload.replace('process.argv[3]', JSON.stringify(lock)));
  assertReturnedWithinBound(child);
});
