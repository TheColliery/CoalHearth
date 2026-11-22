'use strict';
// repo-fs-linkretarget.test.js -- a link's identity is taken from the path the check admitted (r29nz, T-29nw-1). The check resolves the NAME once
// (realpath) and the identity the handle is compared with was a SECOND stat of the name: between the two a link could be re-pointed, and the compare
// then matched the file actually opened. The seam (no privilege needed): the first lstat of the entry reports a link, the first realpath of it
// returns the target (same folder, so the link is honoured), and just after that realpath the entry is re-pointed to a file INSIDE the project
// (INSIDE leg), to a file OUTSIDE it (OUTSIDE leg), or left alone (CONTROL leg). Readers: lib/repo-fs.js readRepoBytes and readRepoText,
// plugin/lib/repo-fs.js readRepoBytes, and scripts/lib/repo-fs.mjs readRepoBytesWithIdentity. Each reader also gets one REAL-link leg, which
// probes whether this account can make a symlink and skips visibly where it cannot. Every temp folder is removed by its teardown after the
// check that it resolves under the OS temp root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const repoFs = require('./repo-fs.js');
const pluginFs = require(path.resolve(__dirname, '..', 'plugin', 'lib', 'repo-fs.js'));

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const MAX = 1 << 20;

// The reader adapters: each answers { text, why } for the entry, so one set of legs covers every reader.
const READERS = {
  'lib/repo-fs.js readRepoBytes': (p, root) => {
    const r = repoFs.readRepoBytes(p, root, MAX);
    return { text: r.bytes ? r.bytes.toString('utf8') : null, why: r.why };
  },
  'lib/repo-fs.js readRepoText': (p, root) => repoFs.readRepoText(p, root, MAX),
  'plugin/lib/repo-fs.js readRepoBytes': (p, root) => {
    const r = pluginFs.readRepoBytes(p, root, MAX);
    return { text: r.bytes ? r.bytes.toString('utf8') : null, why: r.why };
  },
  'scripts/lib/repo-fs.mjs readRepoBytesWithIdentity': async (p, root) => {
    const esm = await import(pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-fs.mjs')).href);
    const r = esm.readRepoBytesWithIdentity(p, root, MAX);
    return { text: r.bytes ? r.bytes.toString('utf8') : null, why: r.why };
  },
};

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29nz-')));
  t.after(() => {
    const r = fs.realpathSync.native(root);
    if (path.dirname(r) === TMP_ROOT && path.basename(r).startsWith('r29nz-')) fs.rmSync(r, { recursive: true, force: true });
  });
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(root, 'outside'));
  const f = {
    root,
    proj,
    target: path.join(proj, 'victim.json'),
    inside: path.join(proj, 'inside.json'),
    outside: path.join(root, 'outside', 'secret.json'),
    entry: path.join(proj, 'coalhearth.json'),
  };
  fs.writeFileSync(f.target, 'VICTIM');
  fs.writeFileSync(f.inside, 'INSIDE');
  fs.writeFileSync(f.outside, 'OUTSIDE');
  fs.linkSync(f.target, f.entry); // the entry starts as another name for the target (a hard link: the same file)
  return f;
}

// Runs body() with the entry looking like a link whose resolution is re-pointed once, just after the first realpath of it, to `next` (or left
// alone when `next` is null). The first lstat of the entry reports a link; the first realpath returns the target.
async function withRetargetedLink(f, next, body) {
  const realL = fs.lstatSync;
  const realR = fs.realpathSync.native;
  let done = false;
  fs.lstatSync = function (q, ...r) {
    const st = realL.call(this, q, ...r);
    if (typeof q === 'string' && path.resolve(q) === path.resolve(f.entry)) {
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isSymbolicLink: () => true });
    }
    return st;
  };
  fs.realpathSync.native = function (q, ...r) {
    if (!done && typeof q === 'string' && path.resolve(q) === path.resolve(f.entry)) {
      done = true;
      if (next) { fs.unlinkSync(f.entry); fs.linkSync(next, f.entry); }
      return f.target;
    }
    return realR.call(this, q, ...r);
  };
  try { return await body(); } finally { fs.lstatSync = realL; fs.realpathSync.native = realR; }
}

for (const [name, read] of Object.entries(READERS)) {
  test(`${name}, CONTROL: the entry still names the victim, so the victim is read`, async (t) => {
    const f = fixture(t);
    const r = await withRetargetedLink(f, null, () => read(f.entry, f.proj));
    assert.equal(r.text, 'VICTIM');
  });

  test(`${name}, INSIDE: the link re-pointed to a file inside the project between the check and the stat is refused, never read`, async (t) => {
    const f = fixture(t);
    const r = await withRetargetedLink(f, f.inside, () => read(f.entry, f.proj));
    assert.equal(r.text, null, 'the re-pointed file is never returned (got ' + r.text + ')');
    assert.equal(r.why, 'refused');
  });

  test(`${name}, OUTSIDE: the link re-pointed to a file outside the project between the check and the stat is refused, never read`, async (t) => {
    const f = fixture(t);
    const r = await withRetargetedLink(f, f.outside, () => read(f.entry, f.proj));
    assert.equal(r.text, null, 'the re-pointed file is never returned (got ' + r.text + ')');
    assert.equal(r.why, 'refused');
  });

  test(`${name}, REAL: a real same-folder symlink reads its target; a real symlink to a file outside the project is refused (skips where this account cannot make a symlink)`, async (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.entry);
    try { fs.symlinkSync(f.target, f.entry); } catch (e) { return t.skip(`this account cannot make a symlink here (${e.code})`); }
    const same = await read(f.entry, f.proj);
    assert.equal(same.text, 'VICTIM', 'a real same-folder link reads its target');
    fs.unlinkSync(f.entry);
    fs.symlinkSync(f.outside, f.entry);
    const out = await read(f.entry, f.proj);
    assert.equal(out.text, null, 'a real link to a file outside the project is never read');
    assert.equal(out.why, 'refused');
  });
}
