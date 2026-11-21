// configure-readonly.test.mjs -- the 0444 refusal (r29mq Z, T-29mi-D2): a config or backup file the user made read-only is refused BY NAME
// before anything is written to it, and is never replaced. These legs run the real configure.mjs in a temp project with a sandboxed home.
// A POSIX root process ignores the write bit, so the legs that need it skip visibly there. Windows reads the same bit as the read-only
// attribute, so these legs run on every platform.
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
const LEGACY_TEXT = JSON.stringify({ language: 'auto' });
const ROOT_IGNORES_MODE = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
const SANDBOXED_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
// the printed refusal, one line: FAIL <file>: read-only; nothing was written -- <fix>
const REFUSAL_TAIL = ': read-only; nothing was written -- make the file writable if you mean to change it';

// Makes every file under a folder writable again, so the teardown can remove it (Windows will not unlink a read-only file).
function makeWritable(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) makeWritable(path.join(p, e));
  try { fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644); } catch { /* best-effort */ }
}

// A temp folder of the test's own making, removed by its teardown only after checking it resolves under the OS temp root.
function project(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29mq-proj-')));
  t.after(() => {
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) === TMP_ROOT && path.basename(real).startsWith('r29mq-proj-')) {
      makeWritable(real);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
  return dir;
}

// Seeds a file the user made read-only: the bytes, then the write bit off.
function readOnly(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o444);
}

// Runs configure.mjs in `dir` with HOME, TEMP and CLAUDE_CONFIG_DIR inside `home` (no real config reaches the child).
function run(dir, home, args) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SANDBOXED_KEYS.includes(k.toUpperCase()) && !/^GIT_/i.test(k)) env[k] = v;
  for (const k of SANDBOXED_KEYS) env[k] = k === 'CLAUDE_CONFIG_DIR' ? path.join(home, '.claude') : home;
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', env: { ...env, NODE_OPTIONS: '--max-old-space-size=2048' },
  });
  assert.equal(r.error, undefined, 'the child ran');
  assert.equal(r.signal, null, 'the child was not killed');
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const refusalLines = (out, file) => out.split(/\r?\n/).filter((l) => l.startsWith('FAIL ') && l.includes(file) && l.includes(REFUSAL_TAIL));

test('a project config the user made read-only is refused by name, is not replaced, and keeps its mode', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const file = path.join(dir, '.claude', 'coal', 'coalhearth.json');
  readOnly(file, '{"language":"th"}\n');
  const r = run(dir, home, ['--language', 'auto']);
  assert.equal(r.status, 1, r.out);
  assert.equal(refusalLines(r.out, file).length, 1, 'one FAIL line names the file and the fix:\n' + r.out);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"language":"th"}\n', 'the bytes are unchanged');
  assert.equal(fs.statSync(file).mode & 0o222, 0, 'the write bit is still off: the file was not replaced');
});

test('a global config the user made read-only is refused by name, is not replaced, and keeps its mode', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const file = path.join(home, '.claude', '.coalhearth.json');
  readOnly(file, '{"language":"th"}\n');
  const r = run(dir, home, ['--global', '--language', 'auto']);
  assert.equal(r.status, 1, r.out);
  assert.equal(refusalLines(r.out, file).length, 1, 'one FAIL line names the global file and the fix:\n' + r.out);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"language":"th"}\n', 'the bytes are unchanged');
  assert.equal(fs.statSync(file).mode & 0o222, 0, 'the write bit is still off: the file was not replaced');
});

test('a read-only earlier backup refuses the migration before the new home is written, and the legacy file stays where it is', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const legacy = path.join(dir, '.coalhearth.json');
  const bak = legacy + '.bak';
  const newHome = path.join(dir, '.claude', 'coal', 'coalhearth.json');
  fs.writeFileSync(legacy, LEGACY_TEXT);
  readOnly(bak, 'EARLIER BACKUP');
  const r = run(dir, home, ['--language', 'th']);
  assert.equal(r.status, 1, r.out);
  assert.equal(refusalLines(r.out, bak).length, 1, 'one FAIL line names the backup and the fix:\n' + r.out);
  assert.equal(fs.existsSync(newHome), false, 'the new home is NOT written: the refusal comes before any write');
  assert.equal(fs.readFileSync(legacy, 'utf8'), LEGACY_TEXT, 'the legacy file is still where it was, with its bytes');
  assert.equal(fs.readFileSync(bak, 'utf8'), 'EARLIER BACKUP', 'the read-only backup is untouched');
});

// r29mq F3 (the reviewer's bounce): a MALFORMED config the user made read-only. The malformed branch wrote its .bak first, then the config write was
// refused with "nothing was written", which was false. Every target is checked before the first write, so nothing is written at all.
test('a malformed config the user made read-only is refused before any backup is written: no .bak, bytes and mode unchanged, the sentence, exit 1', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = project(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const file = path.join(dir, '.claude', 'coal', 'coalhearth.json');
  const malformed = '{ "language": "auto", ';
  readOnly(file, malformed);
  const r = run(dir, home, ['--language', 'th']);
  assert.equal(r.status, 1, r.out);
  assert.equal(fs.existsSync(file + '.bak'), false, 'no .bak is written before the refusal:\n' + r.out);
  assert.equal(refusalLines(r.out, file).length, 1, 'one FAIL line names the file and the fix:\n' + r.out);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed, 'the bytes are unchanged');
  assert.equal(fs.statSync(file).mode & 0o222, 0, 'the write bit is still off: the file was not replaced');
});

test('a target that cannot be inspected is refused with advice about the file, never the folder', async () => {
  const mod = await import(pathToFileURL(path.resolve(here, 'lib', 'repo-fs.mjs')).href);
  assert.equal(typeof mod.refuseIfReadOnly, 'function', 'refuseIfReadOnly is exported');
  const bad = path.join(TMP_ROOT, 'r29mq-bad\u0000name.json');
  let caught = null;
  try { mod.refuseIfReadOnly(bad); } catch (e) { caught = e; }
  assert.ok(caught, 'the target is refused, not treated as absent');
  assert.match(caught.message, /: it could not be inspected \(/, caught.message);
  assert.match(caught.message, /nothing was written/, caught.message);
  assert.match(caught.message, /check that file by hand/, caught.message);
  assert.doesNotMatch(caught.message, /folder|directory/i, 'the advice names the file, not a folder');
});
