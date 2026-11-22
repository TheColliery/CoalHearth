'use strict';
// repo-fs-toctou.test.js -- the reader's check-then-use window (r29ni T, the T-76 class). A reader checks a NAME (lstat, the folder chain, the kind gate)
// and then opens that name; a process that swaps the name between the check and the open made the reader return the swapped file's bytes. The fix
// compares the opened file's device and inode with the ones it checked by name. The seam: fs.openSync is reassigned so the name is swapped just
// before the real open. Legs: a replaced file and another file inside the root, each through readRepoBytes (lib/repo-fs.js) and through
// readRepoBytesWithIdentity (scripts/lib/repo-fs.mjs), and a directory link in the chain (refused before any open). Every leg runs in a temp folder
// of its own, removed by its teardown after checking that it resolves under the OS temp root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repoFs = require('./repo-fs.js');

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const MAX = 1024 * 1024;

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function folder(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29ni-toctou-')));
  t.after(() => {
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) === TMP_ROOT && path.basename(real).startsWith('r29ni-toctou-')) fs.rmSync(real, { recursive: true, force: true });
  });
  return dir;
}

// Reassigns fs.openSync so that, just before the real open of `target`, `swap()` runs once. Returns what was opened through it, so a leg can
// check that the swap ran inside the window and where the reader opened.
function seamOpens(t, target, swap) {
  const realOpen = fs.openSync;
  const opened = [];
  let swapped = false;
  fs.openSync = function (p, ...rest) {
    if (typeof p === 'string') opened.push(p);
    if (!swapped && typeof p === 'string' && path.resolve(p) === path.resolve(target)) { swapped = true; swap(); }
    return realOpen.call(this, p, ...rest);
  };
  t.after(() => { fs.openSync = realOpen; });
  return { opened, didSwap: () => swapped };
}

// Replaces the entry at `target` by a NEW file (created beside it first, then renamed over the name): a new device and inode, as the swap would leave.
function replaceWith(target, text) {
  const tmp = target + '.new';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
}

test('readRepoBytes: a file replaced by name between the check and the open is refused, its bytes never returned', (t) => {
  const root = folder(t);
  const target = path.join(root, 'config.json');
  fs.writeFileSync(target, 'CHECKED');
  const seam = seamOpens(t, target, () => replaceWith(target, 'VICTIM'));
  const r = repoFs.readRepoBytes(target, root, MAX);
  assert.equal(seam.didSwap(), true, 'the swap ran inside the window');
  assert.equal(r.bytes, null, 'the swapped bytes are never returned');
  assert.equal(r.why, 'refused');
});

test('readRepoBytes: another file inside the root swapped in between the check and the open is refused, its bytes never returned', (t) => {
  const root = folder(t);
  const target = path.join(root, 'config.json');
  const other = path.join(root, 'other.json');
  fs.writeFileSync(target, 'CHECKED');
  fs.writeFileSync(other, 'OTHER');
  const seam = seamOpens(t, target, () => fs.renameSync(other, target));
  const r = repoFs.readRepoBytes(target, root, MAX);
  assert.equal(seam.didSwap(), true, 'the swap ran inside the window');
  assert.equal(r.bytes, null, 'the other file\'s bytes are never returned');
  assert.equal(r.why, 'refused');
});

test('readRepoBytesWithIdentity: a file replaced by name between the check and the open is refused, its bytes never returned', async (t) => {
  const esm = await import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-fs.mjs')).href);
  const root = folder(t);
  const target = path.join(root, 'config.json');
  fs.writeFileSync(target, 'CHECKED');
  const seam = seamOpens(t, target, () => replaceWith(target, 'VICTIM'));
  const r = esm.readRepoBytesWithIdentity(target, root, MAX);
  assert.equal(seam.didSwap(), true, 'the swap ran inside the window');
  assert.equal(r.bytes, null, 'the swapped bytes are never returned');
  assert.equal(r.why, 'refused');
});

test('readRepoBytesWithIdentity: another file inside the root swapped in between the check and the open is refused, its bytes never returned', async (t) => {
  const esm = await import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-fs.mjs')).href);
  const root = folder(t);
  const target = path.join(root, 'config.json');
  const other = path.join(root, 'other.json');
  fs.writeFileSync(target, 'CHECKED');
  fs.writeFileSync(other, 'OTHER');
  const seam = seamOpens(t, target, () => fs.renameSync(other, target));
  const r = esm.readRepoBytesWithIdentity(target, root, MAX);
  assert.equal(seam.didSwap(), true, 'the swap ran inside the window');
  assert.equal(r.bytes, null, 'the other file\'s bytes are never returned');
  assert.equal(r.why, 'refused');
});

test('a directory link in the chain of the name is refused before any open of the target', (t) => {
  const root = folder(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'config.json'), 'VIA LINK');
  const link = path.join(root, 'linked');
  try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { return t.skip(`a directory link cannot be made here (${e.code})`); }
  const target = path.join(link, 'config.json');
  const seam = seamOpens(t, target, () => {});
  const r = repoFs.readRepoBytes(target, root, MAX);
  assert.equal(r.bytes, null, 'the link chain is never read');
  assert.equal(r.why, 'refused');
  assert.equal(seam.opened.filter((p) => path.resolve(p) === path.resolve(target)).length, 0, 'the target is never opened through the chain');
});
