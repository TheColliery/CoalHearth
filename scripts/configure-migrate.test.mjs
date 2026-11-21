// configure-migrate.test.mjs -- the legacy-config migration in scripts/configure.mjs (BB-533). After the new home is written, the legacy
// project config is MOVED aside to `<legacy>.bak` by one rename; nothing is removed, and the move reads the backup back against the
// bytes read before it. These legs run the real configure.mjs in a temp project. A preload passed with `--import` injects a change, or
// a failure, at the moment that matters. No git child runs unless a test names git (the tracked case), and that case is skipped
// visibly where git is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitEnv } from './lib/git-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, 'configure.mjs');
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const LEGACY_TEXT = JSON.stringify({ language: 'auto' });
const WINDOWS = process.platform === 'win32';

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function project(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29mi-proj-')));
  t.after(() => {
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) === TMP_ROOT && path.basename(real).startsWith('r29mi-proj-')) fs.rmSync(real, { recursive: true, force: true });
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

// Leg A's preload: the first writeFileSync of the run (the new config's own write, which runs inside the window, before the move)
// changes the legacy file, by an append or a same-size replace, then lets the write run.
const PRELOAD_WRITE = [
  "import fs from 'node:fs';",
  "const target = process.env.R29MI_TARGET; const mode = process.env.R29MI_MODE; let done = false;",
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

// A preload that does nothing: the run is a plain migration.
const PRELOAD_NONE = '// no injected change\n';

// W-c1: a line appended to the legacy file just before the destroying call must not be lost with the file. The preload patches fs.rmSync
// AND fs.renameSync: on the first call that names the legacy file it appends a line, then runs the original. On the old code the delete
// runs after the check, so the appended line goes with the file and the run exits 0. RED on the old code (HEAD 92a48f2).
const PRELOAD_MOVE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "let done = false;",
  "for (const name of ['rmSync', 'renameSync']) {",
  "  const orig = fs[name];",
  "  fs[name] = function (p, ...rest) {",
  "    if (!done && typeof p === 'string' && path.basename(p) === '.coalhearth.json') { done = true; fs.appendFileSync(p, '\\n// appended in the window\\n'); }",
  "    return orig.call(this, p, ...rest);",
  "  };",
  "}",
].join('\n');

// A writer that holds the legacy file open and writes after the move (POSIX: a Windows rename of an open file is refused, see the refused-move leg).
const PRELOAD_FD = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "let done = false;",
  "const orig = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
  "  if (!done && typeof from === 'string' && path.basename(from) === '.coalhearth.json') {",
  "    done = true;",
  "    const fd = fs.openSync(from, 'r+');",
  "    const r = orig.call(this, from, to);",
  "    const size = fs.fstatSync(fd).size;",
  "    fs.writeSync(fd, '\\n// written through an open descriptor after the move\\n', size);",
  "    fs.closeSync(fd);",
  "    return r;",
  "  }",
  "  return orig.call(this, from, to);",
  "};",
].join('\n');

// The rename is refused with EBUSY (a held file, emulated): nothing moves.
const PRELOAD_BUSY = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const orig = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
  "  if (typeof from === 'string' && path.basename(from) === '.coalhearth.json') { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }",
  "  return orig.call(this, from, to);",
  "};",
].join('\n');

// The legacy file is removed mid-run, then the rename fails: the run must not claim the file is kept (a failed rename proves nothing).
const PRELOAD_GONE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const orig = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
  "  if (typeof from === 'string' && path.basename(from) === '.coalhearth.json') { fs.unlinkSync(from); const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }",
  "  return orig.call(this, from, to);",
  "};",
].join('\n');

// The move succeeds, then the backup is replaced by a directory: the read-back cannot be done, and the run must say so.
const PRELOAD_BAK_DIR = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "let done = false;",
  "const orig = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
  "  const r = orig.call(this, from, to);",
  "  if (!done && typeof from === 'string' && path.basename(from) === '.coalhearth.json') { done = true; fs.unlinkSync(to); fs.mkdirSync(to); }",
  "  return r;",
  "};",
].join('\n');

// Runs the real configure.mjs in a fresh temp project. `env` gets the legacy path (the preloads that name it need it); `legacyText`,
// `bakText` seed the files; `prepare(dir)` runs after the seed (the git case).
function runWith(t, preloadSrc, { env = () => ({}), legacyText = LEGACY_TEXT, bakText, prepare } = {}) {
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, preloadSrc);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, legacyText);
  if (bakText !== undefined) fs.writeFileSync(legacy + '.bak', bakText);
  if (prepare) prepare(dir);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, '--language', 'auto'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', env: sandboxEnv(home, env(legacy)),
  });
  assert.equal(r.error, undefined, 'the child ran');
  assert.equal(r.signal, null, 'the child was not killed');
  return { r, legacy, bak: legacy + '.bak', dir, out: (r.stdout || '') + (r.stderr || '') };
}
const linesWith = (out, text) => out.split(/\r?\n/).filter((l) => l.includes(text));

// Leg A: the change lands inside the window, before the move, so the backup holds it. The run exits 1 and one warning names both files.
for (const mode of ['append', 'replace']) {
  test(`Leg A (${mode}): a legacy config changed inside the window is moved to its .bak WITH the change; the run exits 1 and one warning names both files`, (t) => {
    const { r, legacy, bak, out } = runWith(t, PRELOAD_WRITE, { env: (l) => ({ R29MI_TARGET: l, R29MI_MODE: mode }) });
    assert.equal(fs.existsSync(legacy), false, 'the legacy path is moved, not left behind:\n' + out);
    assert.notEqual(fs.readFileSync(bak, 'utf8'), LEGACY_TEXT, 'the backup holds the change made in the window');
    assert.equal(r.status, 1, out);
    assert.ok(linesWith(out, 'differs from').some((l) => l.includes(bak) && l.includes(legacy)), 'one warning names both files:\n' + out);
  });
}

// Leg B: an unchanged legacy config is moved aside, the exit is 0, the one line reads exactly, and the backup holds the original bytes.
test('Leg B: an unchanged legacy config is moved to .bak, the exit is 0, the one line says so, and the .bak holds the original bytes', (t) => {
  const { r, legacy, bak, dir, out } = runWith(t, PRELOAD_NONE);
  assert.equal(r.status, 0, out);
  assert.equal(fs.existsSync(legacy), false, 'the legacy path is moved away');
  assert.equal(fs.readFileSync(bak, 'utf8'), LEGACY_TEXT, 'the backup holds the original bytes');
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'coal', 'coalhearth.json')), 'the canonical config is written');
  const line = linesWith(out, 'Migrated the project config to ');
  assert.equal(line.length, 1, 'exactly one Migrated line:\n' + out);
  assert.ok(line[0].endsWith(`; the old file is kept as ${bak} (no earlier backup).`), `the line reads exactly:\n${line[0]}`);
});

// W-c1 (BB-533, RED on HEAD 92a48f2): the appended line is in the moved file, not lost, and the run is not a success.
test('W-c1: a line appended to the legacy file in the window survives the migration (in the legacy file or its .bak), and the run is not a success', (t) => {
  const { r, legacy, bak, out } = runWith(t, PRELOAD_MOVE);
  const survived = [legacy, bak].some((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('appended in the window'));
  assert.ok(survived, `the appended line is lost with the legacy file; the run said:\n${out}\nexit ${r.status}`);
  assert.notEqual(r.status, 0, `a change the migration did not carry over exits 0:\n${out}`);
});

test('an earlier .bak is replaced by the move, and the one line says so', (t) => {
  const { r, bak, out } = runWith(t, PRELOAD_NONE, { bakText: 'EARLIER BACKUP' });
  assert.equal(r.status, 0, out);
  assert.equal(fs.readFileSync(bak, 'utf8'), LEGACY_TEXT, 'the earlier backup is replaced by the legacy bytes');
  assert.equal(linesWith(out, '(replaced an earlier backup)').length, 1, out);
});

test('a malformed legacy config: the .bak the malformed branch writes in this run is not called an earlier backup', (t) => {
  const malformed = '{ "language": "auto", ';
  const { r, bak, out } = runWith(t, PRELOAD_NONE, { legacyText: malformed });
  assert.equal(r.status, 1, 'the malformed config is a loud exit 1: ' + out);
  assert.equal(fs.readFileSync(bak, 'utf8'), malformed, 'the backup holds the malformed bytes');
  assert.equal(linesWith(out, '(no earlier backup)').length, 1, out);
  assert.equal(linesWith(out, 'replaced an earlier backup').length, 0, out);
});

test('a writer that holds the legacy file open writes after the move: the compare warns and the run exits 1 (POSIX; a Windows rename of an open file is refused, see the refused-move leg)', (t) => {
  if (WINDOWS) return t.skip('a Windows rename of a file held open is refused: the refused-move leg covers that path');
  const { r, bak, out } = runWith(t, PRELOAD_FD);
  assert.equal(r.status, 1, out);
  assert.ok(fs.readFileSync(bak, 'utf8').includes('written through an open descriptor'), 'the late write reached the moved file');
  assert.ok(linesWith(out, 'differs from').length === 1, out);
});

test('a refused rename (EBUSY): nothing moves, the legacy file is kept and named, there is no backup claim, and the exit is 1', (t) => {
  const { r, legacy, bak, out } = runWith(t, PRELOAD_BUSY);
  assert.equal(r.status, 1, out);
  assert.equal(fs.readFileSync(legacy, 'utf8'), LEGACY_TEXT, 'the legacy file is untouched');
  assert.equal(fs.existsSync(bak), false, 'no backup was made');
  assert.equal(linesWith(out, 'It is kept').length, 1, out);
  assert.equal(linesWith(out, 'Migrated the project config').length, 0, 'no success line:\n' + out);
});

test('a legacy file removed mid-run is reported as gone, never as kept (a failed rename does not prove the source is there)', (t) => {
  const { r, legacy, out } = runWith(t, PRELOAD_GONE);
  assert.equal(r.status, 1, out);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(linesWith(out, 'is no longer there').length, 1, out);
  assert.equal(linesWith(out, 'It is kept').length, 0, 'a file that is gone must not be called kept:\n' + out);
});

test('an unreadable backup after the move: the check is said to be not done, the exit is 1, and no success line is printed', (t) => {
  const { r, out } = runWith(t, PRELOAD_BAK_DIR);
  assert.equal(r.status, 1, out);
  assert.equal(linesWith(out, 'could not be read back').length, 1, out);
  assert.equal(linesWith(out, 'Migrated the project config').length, 0, out);
});

test('a legacy config git tracks is moved too, and the one extra line names its removal', (t) => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', env: gitEnv() });
  if (probe.status !== 0) return t.skip('git is not installed here: the tracked line cannot be produced');
  const { r, legacy, bak, out } = runWith(t, PRELOAD_NONE, {
    prepare: (dir) => {
      spawnSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
      spawnSync('git', ['add', '--', '.coalhearth.json'], { cwd: dir, env: gitEnv() });
    },
  });
  assert.equal(r.status, 0, out);
  assert.equal(fs.existsSync(legacy), false, 'the tracked file is moved too');
  assert.equal(linesWith(out, 'is tracked by git: commit its removal (git add -A -- .coalhearth.json).').length, 1, out);
  assert.equal(linesWith(out, `${path.basename(bak)} is untracked and yours to keep or delete.`).length, 1, out);
});

// BB-533 bounce F-a and F-b (the reviewer's witness shapes). F-a: a malformed legacy file beside an earlier .bak. The move replaces the
// earlier backup with the malformed bytes, so the run must say it replaced one. F-b: an earlier .bak and a change in the window; the
// warning must say the earlier backup was replaced. RED on the code before the fix (HEAD 0278923).
const PRELOAD_APPEND_AT_MOVE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "let done = false;",
  "const orig = fs.renameSync;",
  "fs.renameSync = function (from, to) {",
  "  if (!done && typeof from === 'string' && path.basename(from) === '.coalhearth.json') { done = true; fs.appendFileSync(from, '\\n// late\\n'); }",
  "  return orig.call(this, from, to);",
  "};",
].join('\n');

test('F-a (bounce): a malformed legacy file beside an earlier .bak: the .bak holds the malformed bytes and the run says it replaced an earlier backup', (t) => {
  const malformed = '{ "language": "auto", ';
  const { r, bak, out } = runWith(t, PRELOAD_NONE, { legacyText: malformed, bakText: 'EARLIER BACKUP' });
  assert.equal(r.status, 1, out);
  assert.equal(fs.readFileSync(bak, 'utf8'), malformed, 'the .bak holds the malformed legacy bytes');
  assert.equal(linesWith(out, '(replaced an earlier backup)').length, 1, 'the line says it replaced an earlier backup:\n' + out);
  assert.equal(linesWith(out, '(no earlier backup)').length, 0, 'and does not say there was none:\n' + out);
});

test('F-b (bounce): an earlier .bak and a change in the window: the warning says the earlier backup was replaced', (t) => {
  const { r, bak, out } = runWith(t, PRELOAD_APPEND_AT_MOVE, { bakText: 'EARLIER BACKUP' });
  assert.equal(r.status, 1, out);
  assert.ok(fs.readFileSync(bak, 'utf8').includes('// late'), 'the late change is in the .bak');
  assert.equal(linesWith(out, 'differs from').length, 1, out);
  assert.equal(linesWith(out, '(replaced an earlier backup)').length, 1, 'the warning names the replacement:\n' + out);
});
