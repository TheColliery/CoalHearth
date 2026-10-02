// Run: node --test lib/repo-fs.test.js
// CWK-137 (R14): the bounded-read primitive, in isolation. The integration cases (the loaders, the journal, the
// snapshot, the hooks) live in scripts/lib/cwk137.test.mjs. A case this volume cannot build (a FIFO, a device, a file
// symlink without privilege) is a capability-PROBED, VISIBLE skip, CI-measured on ubuntu/macOS -- never manufactured.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./repo-fs.js');

function mk(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-repofs-')));
  t.after(() => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try { if (fs.lstatSync(p).isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } } } catch { /* gone */ }
    }
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}
function link(target, p, dir) {
  try { fs.symlinkSync(target, p, dir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); return true; } catch { return false; }
}
function mkfifo(p) {
  if (process.platform === 'win32') return false;
  const r = spawnSync('mkfifo', [p]);
  try { return !r.error && r.status === 0 && fs.lstatSync(p).isFIFO(); } catch { return false; }
}
// Record every path opened, and REFUSE (throw) the denied ones so a device is never really read.
function spyOpens(deny) {
  const real = fs.openSync;
  const seen = [];
  fs.openSync = function (p, ...a) {
    if (typeof p === 'string') {
      seen.push(path.resolve(p));
      if (deny.some((d) => path.resolve(d) === path.resolve(p))) { const e = new Error('SPY: refused to open ' + p); e.code = 'ESPY'; throw e; }
    }
    return real.call(this, p, ...a);
  };
  return { seen, restore() { fs.openSync = real; } };
}

test('CWK-137: the bounds are 1 MiB (config), 4 MiB (journal and documents), 1 KiB (stamp) -- scripts/lib/cwk137.test.mjs restates them', () => {
  assert.strictEqual(R.MAX_CONFIG_BYTES, 1024 * 1024);
  assert.strictEqual(R.MAX_JOURNAL_BYTES, 4 * 1024 * 1024);
  assert.strictEqual(R.MAX_DOC_BYTES, 4 * 1024 * 1024);
  assert.strictEqual(R.MAX_STAMP_BYTES, 1024);
});

test('CWK-137: a regular file inside the bound is read; exactly at the bound is read; one byte over is SKIPPED with a reason', (t) => {
  const d = mk(t);
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'hello');
  assert.deepStrictEqual(R.readRepoText(f, d, 100), { text: 'hello', why: null });
  assert.strictEqual(R.readRepoFileBounded(f, d, 5), 'hello', 'exactly at the bound');
  assert.deepStrictEqual(R.readRepoText(f, d, 4), { text: null, why: 'too-large' }, 'one byte over');
  assert.strictEqual(R.readRepoFileBounded(f, null, 4), null);
});

test('CWK-137: an absent path is "absent", a directory is "dir", an unresolvable root fails CLOSED ("refused")', (t) => {
  const d = mk(t);
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'x');
  assert.strictEqual(R.readRepoText(path.join(d, 'nope'), d, 10).why, 'absent');
  assert.strictEqual(R.readRepoText(path.join(d, 'sub'), d, 10).why, 'dir');
  assert.strictEqual(R.readRepoText(path.join(d, 'a.txt'), path.join(d, 'no-such-root'), 10).why, 'refused', 'a root that does not resolve contains nothing');
});

test('CWK-137: a read DENIED at the open reports "denied" (EACCES and EPERM both); any other fs error reports "error"', (t) => {
  const d = mk(t);
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'x');
  const real = fs.openSync;
  try {
    for (const [code, why] of [['EACCES', 'denied'], ['EPERM', 'denied'], ['EBUSY', 'error']]) {
      fs.openSync = function (p, ...a) {
        if (typeof p === 'string' && path.resolve(p) === path.resolve(f)) { const e = new Error(code); e.code = code; throw e; }
        return real.call(this, p, ...a);
      };
      assert.strictEqual(R.readRepoText(f, d, 10).why, why, code);
    }
  } finally { fs.openSync = real; }
});

test('CWK-137: the fd re-check -- a path the lstat gate called a regular file is REFUSED when the opened fd is not one', (t) => {
  const d = mk(t);
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'x');
  const real = fs.fstatSync;
  fs.fstatSync = function (fd, ...a) { const st = real.call(this, fd, ...a); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false }); };
  try {
    assert.deepStrictEqual(R.readRepoText(f, d, 10), { text: null, why: 'refused' });
  } finally { fs.fstatSync = real; }
});

test('CWK-137: a directory link (junction) that ESCAPES the root is refused; one that stays inside is read; root null is not contained', (t) => {
  const d = mk(t);
  const out = mk(t);
  fs.writeFileSync(path.join(out, 'x.txt'), 'outside');
  fs.mkdirSync(path.join(d, 'real'));
  fs.writeFileSync(path.join(d, 'real', 'y.txt'), 'inside');
  if (!link(out, path.join(d, 'esc'), true) || !link(path.join(d, 'real'), path.join(d, 'ok'), true)) {
    t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ')');
    return;
  }
  assert.strictEqual(R.readRepoText(path.join(d, 'esc', 'x.txt'), d, 100).why, 'refused', 'through an escaping link');
  assert.strictEqual(R.readRepoFileBounded(path.join(d, 'ok', 'y.txt'), d, 100), 'inside', 'through a contained link');
  assert.strictEqual(R.readRepoFileBounded(path.join(d, 'esc', 'x.txt'), null, 100), 'outside', 'root null = no containment (a HOME file)');
});

test('CWK-137: a file symlink that escapes the root is refused', (t) => {
  const d = mk(t);
  const out = mk(t);
  fs.writeFileSync(path.join(out, 'x.txt'), 'outside');
  if (!link(path.join(out, 'x.txt'), path.join(d, 'l.txt'), false)) {
    t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS');
    return;
  }
  assert.strictEqual(R.readRepoText(path.join(d, 'l.txt'), d, 100).why, 'refused');
  assert.strictEqual(R.readRepoFileBounded(path.join(d, 'l.txt'), null, 100), 'outside');
});

test('CWK-137: a FIFO is never OPENED (decided at the lstat gate)', (t) => {
  const d = mk(t);
  const p = path.join(d, 'pipe');
  if (!mkfifo(p)) { t.skip('mkfifo unavailable here (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  const spy = spyOpens([p]);
  try { assert.deepStrictEqual(R.readRepoText(p, d, 100), { text: null, why: 'refused' }); } finally { spy.restore(); }
  assert.deepStrictEqual(spy.seen.filter((q) => q === path.resolve(p)), [], 'never opened');
});

test('CWK-137: /dev/zero (reached directly or through a link) is refused and never OPENED', (t) => {
  const d = mk(t);
  const l = path.join(d, 'z');
  if (!fs.existsSync('/dev/zero') || !link('/dev/zero', l, false)) { t.skip('no /dev/zero or no file symlink here (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  const spy = spyOpens(['/dev/zero', l]);
  try {
    assert.strictEqual(R.readRepoText('/dev/zero', null, 100).why, 'refused');
    assert.strictEqual(R.readRepoText(l, null, 100).why, 'refused');
  } finally { spy.restore(); }
  assert.deepStrictEqual(spy.seen.filter((q) => q === path.resolve(l) || q === '/dev/zero'), [], 'never opened');
});

// The kind gate on EVERY OS: the stat is injected, so "a FIFO / a device / a link to a device" is decided here without a
// FIFO existing (a Windows box cannot make one). Each case also proves the entry was never OPENED.
function fakeStat(real, over) { return Object.assign(Object.create(Object.getPrototypeOf(real)), real, over); }

test('CWK-137: an entry that is not a file, a directory or a link (what a FIFO, device or socket looks like to lstat) is refused and never OPENED', (t) => {
  const d = mk(t);
  const f = path.join(d, 'pipe');
  fs.writeFileSync(f, 'x');
  const realL = fs.lstatSync;
  fs.lstatSync = function (p, ...a) {
    const st = realL.call(this, p, ...a);
    return typeof p === 'string' && path.resolve(p) === path.resolve(f) ? fakeStat(st, { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => true }) : st;
  };
  const spy = spyOpens([f]);
  try { assert.deepStrictEqual(R.readRepoText(f, d, 100), { text: null, why: 'refused' }); } finally { spy.restore(); fs.lstatSync = realL; }
  assert.deepStrictEqual(spy.seen.filter((q) => q === path.resolve(f)), [], 'never opened');
});

test('CWK-137: a link whose target is not a regular file (a link to /dev/zero) is refused and never OPENED', (t) => {
  const d = mk(t);
  const f = path.join(d, 'z');
  fs.writeFileSync(f, 'x');
  const realL = fs.lstatSync;
  const realS = fs.statSync;
  fs.lstatSync = function (p, ...a) {
    const st = realL.call(this, p, ...a);
    return typeof p === 'string' && path.resolve(p) === path.resolve(f) ? fakeStat(st, { isSymbolicLink: () => true, isFile: () => false }) : st;
  };
  fs.statSync = function (p, ...a) {
    const st = realS.call(this, p, ...a);
    return typeof p === 'string' && path.resolve(p) === path.resolve(f) ? fakeStat(st, { isFile: () => false, isDirectory: () => false }) : st;
  };
  const spy = spyOpens([f]);
  try { assert.deepStrictEqual(R.readRepoText(f, null, 100), { text: null, why: 'refused' }); } finally { spy.restore(); fs.lstatSync = realL; fs.statSync = realS; }
  assert.deepStrictEqual(spy.seen.filter((q) => q === path.resolve(f)), [], 'never opened');
});

test('CWK-137: a dangling link is "absent", a link loop is "refused" (injected: neither can be built portably)', (t) => {
  const d = mk(t);
  const f = path.join(d, 'l');
  fs.writeFileSync(f, 'x');
  const realL = fs.lstatSync;
  const realN = fs.realpathSync.native;
  fs.lstatSync = function (p, ...a) {
    const st = realL.call(this, p, ...a);
    return typeof p === 'string' && path.resolve(p) === path.resolve(f) ? fakeStat(st, { isSymbolicLink: () => true, isFile: () => false }) : st;
  };
  try {
    for (const [code, why] of [['ENOENT', 'absent'], ['ELOOP', 'refused']]) {
      fs.realpathSync.native = function (p, ...a) {
        if (typeof p === 'string' && path.resolve(p) === path.resolve(f)) { const e = new Error(code); e.code = code; throw e; }
        return realN.call(this, p, ...a);
      };
      assert.strictEqual(R.readRepoText(f, d, 10).why, why, code);
    }
  } finally { fs.lstatSync = realL; fs.realpathSync.native = realN; }
});

test('CWK-137: writeTempExclusive creates a fresh file, replaces a leftover entry, and never writes through a hard link or a symlink', (t) => {
  const d = mk(t);
  const out = mk(t);
  const victim = path.join(out, 'victim.txt');
  fs.writeFileSync(victim, 'OUTSIDE');
  const temp = path.join(d, 'x.tmp');
  R.writeTempExclusive(temp, 'one');
  assert.strictEqual(fs.readFileSync(temp, 'utf8'), 'one', 'created');
  R.writeTempExclusive(temp, 'two');
  assert.strictEqual(fs.readFileSync(temp, 'utf8'), 'two', 'a leftover regular temp is replaced');
  fs.rmSync(temp);
  let hard = true;
  try { fs.linkSync(victim, temp); } catch { hard = false; }
  if (hard) {
    R.writeTempExclusive(temp, 'three');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'a hard link is unlinked, not written through');
    assert.strictEqual(fs.readFileSync(temp, 'utf8'), 'three');
    fs.rmSync(temp);
  }
  if (link(victim, temp, false)) {
    R.writeTempExclusive(temp, 'four');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'OUTSIDE', 'a symlink is unlinked, not followed');
    assert.strictEqual(fs.readFileSync(temp, 'utf8'), 'four');
  }
});

test('CWK-137: writeTempExclusive lets any error other than EEXIST propagate to the caller (a missing directory)', (t) => {
  const d = mk(t);
  assert.throws(() => R.writeTempExclusive(path.join(d, 'no-such-dir', 'x.tmp'), 'x'), (e) => e.code === 'ENOENT');
});

// R14 FIXBACK (INSPECT LOW-1, M2; reworked at R14 RED): O_NONBLOCK is the layer that keeps a FIFO swapped in between the lstat and the
// open from blocking the open. No deterministic FIFO is buildable here, so the layer is proven where it is DECIDED: the flags the module
// hands to openSync. The module computes its flags at load, so the test evaluates a FRESH copy of lib/repo-fs.js in which `node:fs` is a
// wrapper whose `constants` is FROZEN and carries a SENTINEL O_NONBLOCK (a bit no real open ever sees, because the wrapper's openSync
// refuses the open itself). Nothing global is written: fs.constants is frozen on POSIX, so a test that assigned to it threw on
// ubuntu/macOS (R14 RED), and the real constant is undefined on Windows, so a check against the real value alone would be a no-op there.
// The wrapper makes the test identical on every OS.
test('CWK-137: the read opens with O_NONBLOCK in its flags (a fresh copy under a frozen sentinel constant; the open itself is refused)', (t) => {
  const d = mk(t);
  const file = path.join(d, 'plain.txt');
  fs.writeFileSync(file, 'x');
  const SENTINEL = 0x40000000;
  const flagsSeen = [];
  const fakeFs = {
    ...fs,
    constants: Object.freeze({ ...fs.constants, O_NONBLOCK: SENTINEL }),
    openSync(p, flags) {
      flagsSeen.push(flags);
      const e = new Error('SPY: refused to open ' + p);
      e.code = 'ESPY';
      throw e;
    },
  };
  assert.strictEqual(Object.isFrozen(fakeFs.constants), true);
  const source = fs.readFileSync(require.resolve('./repo-fs.js'), 'utf8');
  const mod = { exports: {} };
  const fakeRequire = (name) => (name === 'node:fs' || name === 'fs' ? fakeFs : require(name));
  new Function('require', 'module', 'exports', source)(fakeRequire, mod, mod.exports);
  const fresh = mod.exports;
  assert.strictEqual(typeof fresh.readRepoBytes, 'function', 'the fresh copy loaded');
  const r = fresh.readRepoBytes(file, null, 1024);
  assert.strictEqual(flagsSeen.length, 1, 'the file was opened exactly once (and refused by the wrapper)');
  assert.strictEqual(r.why, 'error');
  assert.strictEqual(flagsSeen[0] & SENTINEL, SENTINEL, 'the open carried O_NONBLOCK');
  assert.strictEqual(fresh.REPO_READ_FLAGS & SENTINEL, SENTINEL, 'and so does the exported flag set');
  // And the REAL module, wherever the platform has the constant (POSIX): its flags carry the real O_NONBLOCK.
  if (fs.constants.O_NONBLOCK !== undefined) {
    assert.strictEqual(R.REPO_READ_FLAGS & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK, 'the shipped flags carry the real O_NONBLOCK');
  }
});
