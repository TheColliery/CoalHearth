// configure-global.test.mjs -- r29sh B: the GLOBAL config is written through a temp and renamed into place, at the RESOLVED target of a link
// (a dotfile manager's symlink is followed on purpose). A config a tool reads back is never rewritten in place: a kill mid-write leaves a
// torn file. These legs run the real configure.mjs with a sandboxed home. A link leg skips visibly where this account cannot make a file
// symlink (Windows without developer mode or the privilege). A POSIX root process ignores the write bit, so the read-only leg skips there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, 'configure.mjs');
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
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

// A temp folder of the test's own making. Its teardown removes it only after checking that it resolves directly under the OS temp root.
function sandbox(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'r29sh-glob-')));
  t.after(() => {
    const real = fs.realpathSync.native(dir);
    if (path.dirname(real) === TMP_ROOT && path.basename(real).startsWith('r29sh-glob-')) {
      makeWritable(real);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
  return dir;
}

// Runs configure.mjs in `dir`, with HOME, TEMP and CLAUDE_CONFIG_DIR inside `home` (no real config reaches the child).
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

// The global file the child reads and writes: globalConfigPath under the sandboxed CLAUDE_CONFIG_DIR.
const globalFile = (home) => path.join(home, '.claude', '.coalhearth.json');
const SEED = JSON.stringify({ language: 'auto' }) + '\n';

// Whether this account can make a file symlink here. Probed once per leg, never assumed by platform name.
function canSymlink(dir) {
  const target = path.join(dir, 'probe-target');
  fs.writeFileSync(target, 'x');
  try {
    fs.symlinkSync(target, path.join(dir, 'probe-link'));
    fs.rmSync(path.join(dir, 'probe-link'), { force: true });
    return true;
  } catch {
    return false;
  }
}

test('the global config is written as a new file: its dev and ino change, so it was not rewritten in place', (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.writeFileSync(globalFile(home), SEED);
  const before = fs.statSync(globalFile(home), { bigint: true });
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.out);
  const after = fs.statSync(globalFile(home), { bigint: true });
  assert.ok(before.dev !== after.dev || before.ino !== after.ino,
    `the global file is a new file after the write (dev ${before.dev} ino ${before.ino} before, dev ${after.dev} ino ${after.ino} after)`);
  assert.equal(JSON.parse(fs.readFileSync(globalFile(home), 'utf8')).update.updateMode, 'remind');
});

test('a global config that is a link to a read-only file is refused by name; the target is unchanged and no temp is left', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = sandbox(t);
  if (!canSymlink(dir)) return t.skip(`this account cannot make a file symlink (${process.platform}), so the link refusal is not exercised here`);
  const home = path.join(dir, 'home');
  const target = path.join(dir, 'dotfiles', '.coalhearth.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SEED);
  fs.chmodSync(target, 0o444);
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.symlinkSync(target, globalFile(home));
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 1, r.out);
  const failLines = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL '));
  assert.equal(failLines.length, 1, 'one FAIL line:\n' + r.out);
  assert.ok(failLines[0].includes(target) && failLines[0].includes(REFUSAL_TAIL), 'the FAIL line names the RESOLVED target and the fix:\n' + r.out);
  assert.equal(fs.readFileSync(target, 'utf8'), SEED, 'the read-only target is unchanged');
  assert.ok(fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the link is still a link');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['.coalhearth.json'], 'no temp is left beside the target');
});

test('a global config reached through a link keeps the link, and the link target holds the new bytes', (t) => {
  const dir = sandbox(t);
  if (!canSymlink(dir)) return t.skip(`this account cannot make a file symlink (${process.platform}), so the link write is not exercised here`);
  const home = path.join(dir, 'home');
  const target = path.join(dir, 'dotfiles', '.coalhearth.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SEED);
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.symlinkSync(target, globalFile(home));
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the link is still a link after the write');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).update.updateMode, 'remind', 'the link target holds the new bytes');
  assert.equal(JSON.parse(fs.readFileSync(globalFile(home), 'utf8')).update.updateMode, 'remind', 'reading through the link gives the same bytes');
});

test('control: with no global file yet, --global creates it as a plain file', (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, 'home');
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the new file is a plain file, not a link');
  assert.equal(JSON.parse(fs.readFileSync(globalFile(home), 'utf8')).update.updateMode, 'remind');
});

// r29sm (a): the read-only check and the backup run on the RESOLVED target. A malformed config behind a read-only link is refused by
// name before any .bak is written, beside the link or beside the target.
test('a malformed global config behind a read-only link is refused before any backup is written', (t) => {
  if (ROOT_IGNORES_MODE) return t.skip('a root process on POSIX ignores the write bit, so the refusal cannot be exercised here');
  const dir = sandbox(t);
  if (!canSymlink(dir)) return t.skip(`this account cannot make a file symlink (${process.platform}), so the link backup is not exercised here`);
  const home = path.join(dir, 'home');
  const target = path.join(dir, 'dotfiles', '.coalhearth.json');
  const BROKEN = '{ "language": ';
  const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, BROKEN);
  fs.chmodSync(target, 0o444);
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.symlinkSync(target, globalFile(home));
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.split(/\r?\n/).some((l) => l.startsWith('FAIL ') && l.includes(target)), 'the FAIL line names the RESOLVED target:\n' + r.out);
  assert.equal(fs.readFileSync(target, 'utf8'), BROKEN, 'the read-only target is unchanged');
  assert.ok(!lexists(globalFile(home) + '.bak'), 'no backup is written beside the link');
  assert.ok(!lexists(target + '.bak'), 'no backup is written beside the target');
  assert.ok(fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the link is still a link');
});

// r29sm (b): a rewrite keeps the permission bits of the file it replaces. A rename gives the new file the default mode, so 0600 came back 0644.
test('a rewritten global config keeps the permission bits of the file it replaces', (t) => {
  if (process.platform === 'win32') return t.skip('permission bits are not stored on Windows, so the mode is not exercised here');
  const dir = sandbox(t);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.writeFileSync(globalFile(home), SEED);
  fs.chmodSync(globalFile(home), 0o600);
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.statSync(globalFile(home)).mode & 0o777, 0o600, 'the replacement keeps 0600');
});

// r29sm (c): a link that points at itself is refused by name, and nothing is written. Pins the behaviour; a loop is not reached by the other legs.
test('a global config that links to itself is refused and is not rewritten', (t) => {
  const dir = sandbox(t);
  if (!canSymlink(dir)) return t.skip(`this account cannot make a file symlink (${process.platform}), so the self-link is not exercised here`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.symlinkSync(globalFile(home), globalFile(home));
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 1, r.out);
  assert.ok(!r.out.includes('Successfully'), 'nothing reports a write:\n' + r.out);
  assert.ok(fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the link is still a link');
});

// Pins the dangling-link path: a link to a file that does not exist yet creates that file and keeps the link.
test('a global config link to a file that does not exist yet creates that file and keeps the link', (t) => {
  const dir = sandbox(t);
  if (!canSymlink(dir)) return t.skip(`this account cannot make a file symlink (${process.platform}), so the dangling link is not exercised here`);
  const home = path.join(dir, 'home');
  const target = path.join(dir, 'dotfiles', '.coalhearth.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(globalFile(home)), { recursive: true });
  fs.symlinkSync(target, globalFile(home));
  const r = run(dir, home, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.lstatSync(globalFile(home)).isSymbolicLink(), 'the link is still a link');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).update.updateMode, 'remind', 'the created target holds the new bytes');
});
