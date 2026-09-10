// Hermetic tests for scripts/configure.mjs (CWK-023). Spawns the REAL file (never an
// importable-function extraction) against a sandboxed project dir (a fresh temp dir
// carrying its own `.git`, so findProjectRoot anchors there without ever touching this
// box's real home or the room's own repo) and, for --global, a sandboxed
// CLAUDE_CONFIG_DIR (globalConfigPath reads that env var before falling back to
// os.homedir() -- sandboxing it is enough, no need to fake the OS home directory
// cross-platform).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'configure.mjs');

// mkdtempSync under os.tmpdir() gives a real, NATIVE-Windows-valid absolute path
// (scripts-quality.md's own resource-cleanup rule: t.after() registered the line
// after allocation, before any throwable statement).
function sandboxProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-configure-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git')); // a directory is enough -- findProjectRoot only existsSync-checks the marker path
  return dir;
}
function sandboxHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-configure-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args, envExtra = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...envExtra } });
}
function ownDirConfig(projectDir) {
  return path.join(projectDir, '.claude', 'coal', 'coalhearth.json');
}

// ---------------------------------------------------------------- --help
test('--help exits 0 and names every schema key', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--help']);
  assert.equal(r.status, 0);
  for (const flag of ['--language', '--journal.outputDirectory', '--journal.atomicityRetries',
    '--recovery.autoInjectPrompt', '--recovery.stashUnsavedChanges',
    '--update.updateMode', '--update.updateCheckDays']) {
    assert.ok(r.stdout.includes(flag), `help text missing ${flag}`);
  }
  assert.ok(r.stdout.includes('--global'));
  assert.ok(r.stdout.includes('--help, -h'));
});

test('no args at all ALSO prints help and exits 0 (both exemplars\' own shape)', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, []);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('--language'));
});

// ---------------------------------------------------------------- --language stays SCALAR
test('--language writes a plain top-level scalar, never wrapped in an object', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--language', 'th']);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.equal(cfg.language, 'th');
});

test('--language OVER an existing malformed object value still lands as a plain scalar', (t) => {
  const dir = sandboxProject(t);
  const p = ownDirConfig(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ language: { nested: 'garbage' } }));
  const r = run(dir, ['--language', 'ja']);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.language, 'ja');
});

// ---------------------------------------------------------------- nested write, no sibling clobber
test('a nested write does NOT clobber a sibling key already in the same group', (t) => {
  const dir = sandboxProject(t);
  let r = run(dir, ['--journal.outputDirectory', '.claude/coalhearth']);
  assert.equal(r.status, 0);
  r = run(dir, ['--journal.atomicityRetries', '4']);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.deepEqual(cfg.journal, { outputDirectory: '.claude/coalhearth', atomicityRetries: 4 });
});

test('two flags in the SAME group in ONE invocation both land, neither drops the other', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--recovery.autoInjectPrompt', 'false', '--recovery.stashUnsavedChanges', 'false']);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.deepEqual(cfg.recovery, { autoInjectPrompt: false, stashUnsavedChanges: false });
});

// ---------------------------------------------------------------- each type parsed
test('bool type: true/false parsed, anything else rejected', (t) => {
  const dir = sandboxProject(t);
  let r = run(dir, ['--recovery.autoInjectPrompt', 'true']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8')).recovery.autoInjectPrompt, true);
  r = run(dir, ['--recovery.autoInjectPrompt', 'yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs true or false/);
});

test('int type: an in-range integer parsed, an out-of-range or non-integer rejected', (t) => {
  const dir = sandboxProject(t);
  let r = run(dir, ['--journal.atomicityRetries', '3']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8')).journal.atomicityRetries, 3);
  r = run(dir, ['--journal.atomicityRetries', '0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be >= 1/);
  r = run(dir, ['--journal.atomicityRetries', '5.9']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be an integer/);
});

test('enum type: a listed value (any case) parsed lowercase, an unlisted value rejected', (t) => {
  const dir = sandboxProject(t);
  let r = run(dir, ['--update.updateMode', 'AUTO']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8')).update.updateMode, 'auto');
  r = run(dir, ['--update.updateMode', 'sometimes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be one of: ask, auto, remind, off/);
});

test('string type: any string value parsed as-is -- the case neither exemplar needed', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--journal.outputDirectory', 'somewhere/else']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8')).journal.outputDirectory, 'somewhere/else');
});

// ---------------------------------------------------------------- --global
test('--global writes the GLOBAL layer under a sandboxed CLAUDE_CONFIG_DIR, not the project config', (t) => {
  const projectDir = sandboxProject(t);
  const homeDir = sandboxHome(t);
  const r = run(projectDir, ['--global', '--update.updateMode', 'remind'], { CLAUDE_CONFIG_DIR: homeDir });
  assert.equal(r.status, 0);
  const globalCfg = JSON.parse(fs.readFileSync(path.join(homeDir, '.coalhearth.json'), 'utf8'));
  assert.equal(globalCfg.update.updateMode, 'remind');
  assert.equal(fs.existsSync(ownDirConfig(projectDir)), false, '--global must not touch the project config at all');
});

// ---------------------------------------------------------------- invalid value writes NOTHING
test('an invalid value exits non-zero and writes NOTHING -- not even a fresh empty file', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--update.updateMode', 'bogus']);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(ownDirConfig(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false, 'not even the directory should exist');
});

test('an invalid value does not clobber an ALREADY-existing config either', (t) => {
  const dir = sandboxProject(t);
  const p = ownDirConfig(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const before = JSON.stringify({ language: 'en' });
  fs.writeFileSync(p, before);
  const r = run(dir, ['--update.updateMode', 'bogus']);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'the existing file must be untouched on a rejected value');
});

test('an unrecognized flag exits non-zero, prints help, writes nothing', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--nope', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unrecognized option '--nope'/);
  assert.ok(r.stdout.includes('--language'), 'help text prints after the error');
  assert.equal(fs.existsSync(ownDirConfig(dir)), false);
});

// ---------------------------------------------------------------- malformed existing config
test('a malformed existing config is backed up + rebuilt from defaults, exit 1, warns', (t) => {
  const dir = sandboxProject(t);
  const p = ownDirConfig(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not json');
  const r = run(dir, ['--language', 'en']);
  assert.equal(r.status, 1, 'malformed-config recovery still reports the non-zero it found');
  assert.ok(fs.existsSync(p + '.bak'), 'the malformed file is backed up');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(cfg.language, 'en', 'the run still continues and applies the requested flag');
});

// ---------------------------------------------------------------- legacy migration
test('a config found at the LEGACY root path migrates to the own-dir default on write', (t) => {
  const dir = sandboxProject(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(legacy), false, 'the legacy file is removed after a successful migrated write');
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.equal(cfg.language, 'zh');
});
