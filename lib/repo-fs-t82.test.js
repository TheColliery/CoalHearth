'use strict';
// repo-fs-t82.test.js -- T-82 (r29nz): the folder-swap seam of the reader's walk (the reviewer's SWAP leg). A folder in the chain is swapped OUT
// for the first lstat of the entry and for the open, and back IN for the folder walk and the realpath. Modelled without privilege: the FIRST
// lstat of the entry answers with the outside file's lstat, and the open of the entry opens the outside file; every other call sees the real
// inside tree. CONTROL: no seam. The identity the reader compares must come from the inside walk, so the open of the outside file is refused.
// Stated limit (T-82): a folder swap with exact timing between the check and the open is not closed by any Node call on Windows or macOS; this
// seam is one swap, not that. Readers: lib/repo-fs.js readRepoBytes and scripts/lib/repo-fs.mjs readRepoBytesWithIdentity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repoFs = require('./repo-fs.js');

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const MAX = 1 << 20;

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29nz-t82-')));
  t.after(() => {
    const r = fs.realpathSync.native(root);
    if (path.dirname(r) === TMP_ROOT && path.basename(r).startsWith('r29nz-t82-')) fs.rmSync(r, { recursive: true, force: true });
  });
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outside', '.claude'), { recursive: true });
  const f = {
    proj,
    entry: path.join(proj, '.claude', 'coalhearth.json'),
    outside: path.join(root, 'outside', '.claude', 'coalhearth.json'),
  };
  fs.writeFileSync(f.entry, 'VICTIM');
  fs.writeFileSync(f.outside, 'OUTSIDE');
  return f;
}

// The SWAP seam: the first lstat of the entry and the open of the entry are answered as if the folder were the outside one.
function withSwapSeam(f, body) {
  const realL = fs.lstatSync;
  const realO = fs.openSync;
  let first = true;
  fs.lstatSync = function (q, ...r) {
    if (first && typeof q === 'string' && path.resolve(q) === path.resolve(f.entry)) { first = false; return realL.call(this, f.outside, ...r); }
    return realL.call(this, q, ...r);
  };
  fs.openSync = function (q, ...r) {
    return realO.call(this, typeof q === 'string' && path.resolve(q) === path.resolve(f.entry) ? f.outside : q, ...r);
  };
  try { return body(); } finally { fs.lstatSync = realL; fs.openSync = realO; }
}

test('T-82 CONTROL, readRepoBytes: no seam, the inside entry is read', (t) => {
  const f = fixture(t);
  const r = repoFs.readRepoBytes(f.entry, f.proj, MAX);
  assert.equal(r.bytes && r.bytes.toString('utf8'), 'VICTIM');
});

test('T-82 SWAP, readRepoBytes: a folder swapped out for the first lstat and the open, back in for the walk, is refused, never the outside file', (t) => {
  const f = fixture(t);
  const r = withSwapSeam(f, () => repoFs.readRepoBytes(f.entry, f.proj, MAX));
  assert.equal(r.bytes, null, 'the outside file is never returned (got ' + (r.bytes && r.bytes.toString('utf8')) + ')');
  assert.equal(r.why, 'refused');
});

test('T-82 CONTROL, readRepoBytesWithIdentity: no seam, the inside entry is read', async (t) => {
  const esm = await import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-fs.mjs')).href);
  const f = fixture(t);
  const r = esm.readRepoBytesWithIdentity(f.entry, f.proj, MAX);
  assert.equal(r.bytes && r.bytes.toString('utf8'), 'VICTIM');
});

test('T-82 SWAP, readRepoBytesWithIdentity: a folder swapped out for the first lstat and the open, back in for the walk, is refused, never the outside file', async (t) => {
  const esm = await import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-fs.mjs')).href);
  const f = fixture(t);
  const r = withSwapSeam(f, () => esm.readRepoBytesWithIdentity(f.entry, f.proj, MAX));
  assert.equal(r.bytes, null, 'the outside file is never returned (got ' + (r.bytes && r.bytes.toString('utf8')) + ')');
  assert.equal(r.why, 'refused');
});
