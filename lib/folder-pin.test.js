// Run: node --test lib/folder-pin.test.js
// CWK2-037 (15b5): the project-config FOLDER CHAIN is pinned to its literal location (hooks-safety.md section 6 row 10 as amended 2026-10-04; node/runtime.md section 4: an allowlist pins the
// LITERAL expected location). A junction (Windows) or directory symlink (POSIX) planted at `.claude` or at `.claude/coal` leaves the config file itself lstat-ing as a plain file, so the
// read used to follow it to a folder INSIDE the project and hand that folder's coalhearth.json to loadConfig. Now any link on the chain between the project root and the entry's own folder is
// refused, wherever it points. The root itself is not walked (a project opened through a linked path still reads its own files).
// Directory-link legs are capability-PROBED, VISIBLE skips (a volume without the privilege), CI-measured on ubuntu/macOS where the symlink is a real POSIX link.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./repo-fs.js');
const { loadConfig, configNotices } = require('./load-config.js');
const { containedOutputDir } = require('./contained-dir.js');

delete process.env.CLAUDE_CONFIG_DIR;

const MARKER = 'MARKER-37';

function mk(t) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-folderpin-')));
  t.after(() => {
    // unlink any planted link first so rmSync never recurses through it
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        let st; try { st = fs.lstatSync(p); } catch { continue; }
        if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* gone */ } } } else if (st.isDirectory()) walk(p);
      }
    };
    walk(d);
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}
function dirLink(target, p) {
  try { fs.symlinkSync(target, p, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function project(t) {
  const base = mk(t);
  const proj = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { base, proj, home };
}
const cfgJson = JSON.stringify({ language: MARKER });

// Plants: a real config in `elsewhere`, a link to it at the position under test. Returns false when this volume refuses a directory link.
const PLANTS = {
  '.claude': (proj) => {
    write(path.join(proj, 'elsewhere', 'coal', 'coalhearth.json'), cfgJson);
    return dirLink(path.join(proj, 'elsewhere'), path.join(proj, '.claude'));
  },
  '.claude/coal': (proj) => {
    write(path.join(proj, 'elsewhere', 'coalhearth.json'), cfgJson);
    fs.mkdirSync(path.join(proj, '.claude'));
    return dirLink(path.join(proj, 'elsewhere'), path.join(proj, '.claude', 'coal'));
  },
};
const CONFIG = (proj) => path.join(proj, '.claude', 'coal', 'coalhearth.json');

for (const where of Object.keys(PLANTS)) {
  test(`CWK2-037 repo-fs: a directory link at ${where} (target INSIDE the project) is refused by readRepoText and repoEntryInfo, never read`, (t) => {
    const { proj } = project(t);
    if (!PLANTS[where](proj)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
    assert.strictEqual(fs.readFileSync(CONFIG(proj), 'utf8'), cfgJson, 'setup: the link really reaches the marker file');
    assert.deepStrictEqual(R.readRepoText(CONFIG(proj), proj, 1000), { text: null, why: 'refused' });
    assert.deepStrictEqual(R.repoEntryInfo(CONFIG(proj), proj), { kind: 'refused' });
    assert.strictEqual(R.readRepoFileBounded(CONFIG(proj), proj, 1000), null);
  });

  test(`CWK2-037 loadConfig: a directory link at ${where} hands NOTHING to the merged config`, (t) => {
    const { proj, home } = project(t);
    if (!PLANTS[where](proj)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
    const cfg = loadConfig({ cwd: proj, home });
    assert.notStrictEqual(cfg.language, MARKER, 'the marker must not arrive through the link');
    assert.deepStrictEqual(cfg, {});
  });

  test(`CWK2-037 configNotices: a directory link at ${where} is reported UNREADABLE (the closed set of four reasons), not silently skipped`, (t) => {
    const { proj, home } = project(t);
    if (!PLANTS[where](proj)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
    const lines = configNotices({ cwd: proj, home });
    const hit = lines.filter((l) => l.startsWith('UNREADABLE: ') && l.includes('exists but is not a readable config (unreadable)'));
    assert.strictEqual(hit.length, 1, 'one UNREADABLE line, got ' + JSON.stringify(lines));
    assert.ok(hit[0].includes('coalhearth.json'), hit[0]);
  });
}

test('CWK2-037 control: the same config in a REAL folder chain still reads, through repo-fs and loadConfig', (t) => {
  const { proj, home } = project(t);
  write(CONFIG(proj), cfgJson);
  assert.strictEqual(R.readRepoFileBounded(CONFIG(proj), proj, 1000), cfgJson);
  assert.strictEqual(R.repoEntryInfo(CONFIG(proj), proj).kind, 'file');
  assert.strictEqual(loadConfig({ cwd: proj, home }).language, MARKER);
  assert.deepStrictEqual(configNotices({ cwd: proj, home }), []);
});

test('CWK2-037: the ROOT itself reached through a link is not walked -- a project opened through a linked path still reads its own files', (t) => {
  const { base, proj } = project(t);
  write(CONFIG(proj), cfgJson);
  const linked = path.join(base, 'linked-root');
  if (!dirLink(proj, linked)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  assert.strictEqual(R.readRepoFileBounded(CONFIG(linked), linked, 1000), cfgJson);
});

test('CWK2-037: root = null (a HOME file) keeps following links -- a dotfile manager legitimately links it', (t) => {
  const { proj } = project(t);
  if (!PLANTS['.claude'](proj)) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  assert.strictEqual(R.readRepoFileBounded(CONFIG(proj), null, 1000), cfgJson);
});

test('CWK2-037: an entry directly inside its root has no folder chain to walk (the journal and doc reads root at the folder holding the file)', (t) => {
  const { proj } = project(t);
  write(path.join(proj, 'AGENTS.md'), 'doc');
  assert.strictEqual(R.readRepoFileBounded(path.join(proj, 'AGENTS.md'), proj, 100), 'doc');
  assert.strictEqual(R.repoEntryInfo(path.join(proj, 'AGENTS.md'), proj).kind, 'file');
});

test('CWK2-037: a path that is not lexically under the root fails CLOSED (refused), never a throw', (t) => {
  const { proj } = project(t);
  const out = mk(t);
  write(path.join(out, 'x.json'), '{}');
  assert.deepStrictEqual(R.repoEntryInfo(path.join(out, 'x.json'), proj), { kind: 'refused' });
});

for (const where of ['.claude', '.claude/coalhearth']) {
  test(`CWK2-037 default journal folder: containedOutputDir is already literal -- a directory link at ${where} (target inside the project) yields null, nothing created`, (t) => {
    const { proj, home } = project(t);
    fs.mkdirSync(path.join(proj, 'elsewhere', 'coalhearth'), { recursive: true });
    if (where === '.claude') {
      if (!dirLink(path.join(proj, 'elsewhere'), path.join(proj, '.claude'))) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
    } else {
      fs.mkdirSync(path.join(proj, '.claude'));
      if (!dirLink(path.join(proj, 'elsewhere', 'coalhearth'), path.join(proj, '.claude', 'coalhearth'))) { t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
    }
    const before = fs.readdirSync(path.join(proj, 'elsewhere', 'coalhearth')).length;
    assert.strictEqual(containedOutputDir(undefined, proj), null);
    assert.strictEqual(fs.readdirSync(path.join(proj, 'elsewhere', 'coalhearth')).length, before, 'nothing created in the link target');
  });
}

test('CWK2-037: the ENTRY rule is unchanged -- a file symlink at the entry whose realpath stays inside the root is still read; one that leaves the root is still refused', (t) => {
  const { proj } = project(t);
  const out = mk(t);
  write(path.join(proj, 'docs', 'real.md'), 'inside');
  write(path.join(out, 'x.md'), 'outside');
  try { fs.symlinkSync(path.join(proj, 'docs', 'real.md'), path.join(proj, 'AGENTS.md'), 'file'); fs.symlinkSync(path.join(out, 'x.md'), path.join(proj, 'OUT.md'), 'file'); } catch { t.skip('file symlink not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS'); return; }
  assert.strictEqual(R.readRepoFileBounded(path.join(proj, 'AGENTS.md'), proj, 100), 'inside');
  assert.strictEqual(R.readRepoText(path.join(proj, 'OUT.md'), proj, 100).why, 'refused');
});

test('CWK2-037: a folder on the chain that cannot be lstat-ed (EACCES, injected) fails CLOSED -- refused, never read, never a throw', (t) => {
  const { proj } = project(t);
  write(CONFIG(proj), cfgJson);
  const folder = path.join(proj, '.claude');
  const real = fs.lstatSync;
  fs.lstatSync = function (p, ...a) {
    if (typeof p === 'string' && path.resolve(p) === folder) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return real.call(this, p, ...a);
  };
  try {
    assert.deepStrictEqual(R.folderChain(CONFIG(proj), proj), { ok: false, why: 'error' });
    assert.deepStrictEqual(R.repoEntryInfo(CONFIG(proj), proj), { kind: 'refused' });
    assert.strictEqual(R.readRepoFileBounded(CONFIG(proj), proj, 1000), null);
  } finally { fs.lstatSync = real; }
});
