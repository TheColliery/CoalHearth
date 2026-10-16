// CWK2-037 (15b5), the WRITER half: configure.mjs and scripts/lib/repo-fs.mjs. A junction (Windows) or directory symlink (POSIX) planted at `.claude` or `.claude/coal` redirected the config
// WRITE (and the `.bak`) to another folder INSIDE the project: the old guard only asked that the deepest existing ancestor's realpath stay inside the project root. The class rule
// (hooks-safety.md section 6 row 10; node/runtime.md section 4) pins the LITERAL location, so any link on the chain between the project root and the target's folder is refused, wherever it
// points. The read half is lib/folder-pin.test.js. Directory-link legs are capability-PROBED, VISIBLE skips, CI-measured on ubuntu/macOS.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRepoWriteTarget, writeRepoFile, RepoWriteRefused } from './lib/repo-fs.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'configure.mjs');
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-folderpin-home-'));
after(() => fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }));
const SANDBOXED_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
function sandboxedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SANDBOXED_KEYS.includes(k.toUpperCase())) out[k] = v;
  for (const k of SANDBOXED_KEYS) out[k] = k === 'CLAUDE_CONFIG_DIR' ? path.join(SANDBOX_HOME, '.claude') : SANDBOX_HOME;
  return out;
}

function project(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-folderpin-w-')));
  t.after(() => {
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        let st; try { st = fs.lstatSync(p); } catch { continue; }
        if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* gone */ } } } else if (st.isDirectory()) walk(p);
      }
    };
    walk(base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  return { base, proj };
}
function dirLink(target, p) {
  try { fs.symlinkSync(target, p, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
const SKIP = (t) => t.skip('directory symlink/junction not permitted on this volume (' + process.platform + ') -- CI-measured on ubuntu/macOS');
// t121 (CodeRabbit, 15b5): a spawn that fails or times out has status null, and a missing script exits 1 for an unrelated reason, so `notStrictEqual(r.status, 0)` plus an untouched target can pass
// without configure.mjs ever refusing the link. The refusal is OBSERVED: the spawn completed (no error, no signal), the exact refusal status configure.mjs sets for it (process.exitCode = 1),
// and the message that names which refusal it was.
function assertRefusal(r, message) {
  assert.equal(r.error, undefined, 'the spawn itself must complete: ' + (r.error && r.error.message));
  assert.equal(r.signal, null, 'the child was not killed by a signal: ' + r.signal);
  assert.equal(r.status, 1, 'configure.mjs refuses with exit status 1, got ' + r.status + '\n' + r.stdout + r.stderr);
  assert.match(r.stderr, message, 'the refusal says which one it was:\n' + r.stderr);
}
const TARGET = (proj) => path.join(proj, '.claude', 'coal', 'coalhearth.json');

// where -> plant a link there whose target is a folder INSIDE the project; returns false when the volume refuses the link
const PLANTS = {
  '.claude': (proj) => { fs.mkdirSync(path.join(proj, 'elsewhere'), { recursive: true }); return dirLink(path.join(proj, 'elsewhere'), path.join(proj, '.claude')); },
  '.claude/coal': (proj) => {
    fs.mkdirSync(path.join(proj, 'elsewhere'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'));
    return dirLink(path.join(proj, 'elsewhere'), path.join(proj, '.claude', 'coal'));
  },
};
const LANDED = { '.claude': (proj) => path.join(proj, 'elsewhere', 'coal'), '.claude/coal': (proj) => path.join(proj, 'elsewhere', 'coalhearth.json') };

for (const where of Object.keys(PLANTS)) {
  test(`CWK2-037 writer: checkRepoWriteTarget and writeRepoFile REFUSE a directory link at ${where} (target inside the project) and create nothing in its target`, (t) => {
    const { proj } = project(t);
    if (!PLANTS[where](proj)) return SKIP(t);
    assert.throws(() => checkRepoWriteTarget(TARGET(proj), proj), RepoWriteRefused);
    assert.throws(() => writeRepoFile(TARGET(proj), '{"language":"th-TH"}\n', proj), RepoWriteRefused);
    assert.strictEqual(fs.existsSync(LANDED[where](proj)), false, 'nothing landed in the link target');
  });

  test(`CWK2-037 configure.mjs: a directory link at ${where} makes the config write exit non-zero and leaves the link target untouched`, (t) => {
    const { proj } = project(t);
    if (!PLANTS[where](proj)) return SKIP(t);
    const r = spawnSync(process.execPath, [script, '--language', 'th'], { cwd: proj, encoding: 'utf8', env: sandboxedEnv(), timeout: 30000, killSignal: 'SIGKILL' });
    assertRefusal(r, /refused to write the config/);
    assert.strictEqual(fs.existsSync(LANDED[where](proj)), false, 'nothing landed in the link target');
  });

  test(`CWK2-037 configure.mjs: an EXISTING config reached through a directory link at ${where} is a loud refusal (never read, never rewritten)`, (t) => {
    const { proj } = project(t);
    if (!PLANTS[where](proj)) return SKIP(t);
    const real = where === '.claude' ? path.join(proj, 'elsewhere', 'coal', 'coalhearth.json') : path.join(proj, 'elsewhere', 'coalhearth.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const body = '{"language":"MARKER-37"}';
    fs.writeFileSync(real, body);
    const r = spawnSync(process.execPath, [script, '--language', 'th'], { cwd: proj, encoding: 'utf8', env: sandboxedEnv(), timeout: 30000, killSignal: 'SIGKILL' });
    assertRefusal(r, /cannot be read safely \(refused\)/);
    assert.strictEqual(fs.readFileSync(real, 'utf8'), body, 'the file behind the link is untouched');
  });
}

test('CWK2-037 writer control: a REAL folder chain writes, and the project root reached through a link is not walked', (t) => {
  const { base, proj } = project(t);
  writeRepoFile(TARGET(proj), '{"language":"th-TH"}\n', proj);
  assert.strictEqual(fs.readFileSync(TARGET(proj), 'utf8'), '{"language":"th-TH"}\n');
  const linked = path.join(base, 'linked-root');
  if (!dirLink(proj, linked)) return SKIP(t);
  writeRepoFile(TARGET(linked), '{"language":"en"}\n', linked);
  assert.strictEqual(fs.readFileSync(TARGET(proj), 'utf8'), '{"language":"en"}\n');
});

test('CWK2-037 writer: root = null (the user\'s own global config) keeps following links', (t) => {
  const { proj } = project(t);
  if (!PLANTS['.claude'](proj)) return SKIP(t);
  writeRepoFile(TARGET(proj), '{"language":"th-TH"}\n', null);
  assert.strictEqual(fs.readFileSync(path.join(proj, 'elsewhere', 'coal', 'coalhearth.json'), 'utf8'), '{"language":"th-TH"}\n');
});

test('CWK2-037 writer: a folder on the chain that cannot be lstat-ed (EACCES, injected) is a RepoWriteRefused, never a write', (t) => {
  const { proj } = project(t);
  fs.mkdirSync(path.join(proj, '.claude', 'coal'), { recursive: true });
  const folder = path.join(proj, '.claude');
  const real = fs.lstatSync;
  fs.lstatSync = function (p, ...a) {
    if (typeof p === 'string' && path.resolve(p) === folder) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return real.call(this, p, ...a);
  };
  try {
    assert.throws(() => checkRepoWriteTarget(TARGET(proj), proj), RepoWriteRefused);
    assert.throws(() => writeRepoFile(TARGET(proj), '{}\n', proj), RepoWriteRefused);
  } finally { fs.lstatSync = real; }
  assert.strictEqual(fs.existsSync(TARGET(proj)), false, 'nothing was written');
});
