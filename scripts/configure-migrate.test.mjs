// configure-migrate.test.mjs -- the legacy-config migration in scripts/configure.mjs must not delete a legacy file that changed
// inside its window (T-53, the reviewer's witness b47d856d, 2026-11-20, ported into the suite). The migration reads the legacy
// root `.coalhearth.json`, writes the canonical `.claude/coal/coalhearth.json`, asks git whether it tracks the legacy file, then
// removes it (`fs.rmSync(readPath)`). An edit to the legacy file made inside that window is in neither file.
// INJECTION POINT (PORT NOTE, T-53 fix): the reviewer's copy changed the file inside `fs.rmSync`, after the check the fix makes; a
// check made before the delete cannot see a change made inside the delete (the residual window the fix states). So the injection
// moved to the first `fs.writeFileSync` of the run: the new config's own write, which runs after the first read and before the
// re-check, inside the window the check guards. A preload passed with `--import` wraps `fs.writeFileSync`; on that first call it
// changes the legacy file (an append, or a same-size replace) and then lets the write run.
// The project has no `.git` and sits under the OS temp root (no repository above it), so gitTracks answers 'untracked' and the delete runs.
// No git child is spawned by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, 'configure.mjs');
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());

const PRELOAD = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const target = process.env.R29KN_TARGET; const mode = process.env.R29KN_MODE; let done = false;",
  "const origWrite = fs.writeFileSync;",
  "fs.writeFileSync = function (p, ...rest) {",
  "  if (!done && target && fs.existsSync(target)) {",
  "    done = true;",
  "    if (mode === 'append') fs.appendFileSync(target, '\\n');",
  "    if (mode === 'replace') { const b = fs.readFileSync(target); origWrite(target, Buffer.from(b.toString('utf8').replace('auto', 'zzzz'), 'utf8')); }",
  "  }",
  "  return origWrite.call(this, p, ...rest);",
  "};",
].join('\n');

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function project(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29kn-proj-')));
  t.after(() => {
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) === TMP_ROOT && path.basename(real).startsWith('r29kn-proj-')) fs.rmSync(real, { recursive: true, force: true });
  });
  return dir;
}
// The room's sandbox convention (configure.test.mjs sandboxedEnv): no real HOME, TEMP or CLAUDE_CONFIG_DIR reaches the child.
const SANDBOXED_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
function sandboxEnv(home, extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SANDBOXED_KEYS.includes(k.toUpperCase()) && !/^GIT_/i.test(k)) out[k] = v;
  for (const k of SANDBOXED_KEYS) out[k] = k === 'CLAUDE_CONFIG_DIR' ? path.join(home, '.claude') : home;
  return { ...out, NODE_OPTIONS: '--max-old-space-size=2048', ...extra };
}
function migrate(t, mode) {
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, PRELOAD);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--language', 'auto'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    env: sandboxEnv(home, { R29KN_TARGET: legacy, R29KN_MODE: mode }),
  });
  assert.equal(r.error, undefined, 'the child ran');
  assert.equal(r.signal, null, 'the child was not killed');
  return { r, legacy, dir };
}

for (const mode of ['append', 'replace']) {
  test(`Leg A (${mode}): a legacy config changed inside the window is KEPT, the exit is non-zero and one plain line names it`, (t) => {
    const { r, legacy } = migrate(t, mode);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(fs.existsSync(legacy), 'the changed legacy file survives: ' + JSON.stringify(out));
    assert.notEqual(r.status, 0, 'the run exits non-zero');
    assert.ok(out.split(/\r?\n/).some((l) => l.includes(legacy)), 'one line names the kept legacy file');
  });
}

test('Leg B: an unchanged legacy config still migrates, the legacy file is removed and the exit is 0', (t) => {
  const { r, legacy, dir } = migrate(t, 'none');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.equal(fs.existsSync(legacy), false, 'the legacy file is removed');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'coal', 'coalhearth.json')), 'the canonical config is written');
});
