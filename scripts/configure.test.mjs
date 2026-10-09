// Hermetic tests for scripts/configure.mjs (CWK-023). Spawns the REAL file (never an
// importable-function extraction) against a sandboxed project dir (a fresh temp dir
// carrying its own `.git`, so findProjectRoot anchors there without ever touching this
// box's real home or the room's own repo) and, for --global, a sandboxed
// CLAUDE_CONFIG_DIR (globalConfigPath reads that env var before falling back to
// os.homedir() -- sandboxing it is enough, no need to fake the OS home directory
// cross-platform).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/git-env.mjs';

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

// R20 (the same class as CodeRabbit PR #19 thread 20, found by the sweep one file over): a spawned configure.mjs got the parent's environment, so a run that reaches the global
// layer without its own CLAUDE_CONFIG_DIR would read or WRITE the operator's real global config (globalConfigPath honours CLAUDE_CONFIG_DIR, then HOME). The default is now a throwaway
// directory for HOME, USERPROFILE, TEMP, TMP and TMPDIR and a CLAUDE_CONFIG_DIR inside it; a caller's own keys (the --global tests pass theirs; one test overrides PATH) still win.
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-configure-sandbox-'));
after(() => fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }));
const SANDBOXED_KEYS = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR'];
function sandboxedEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SANDBOXED_KEYS.includes(k.toUpperCase())) out[k] = v; // Windows names are case-insensitive
  for (const k of SANDBOXED_KEYS) out[k] = k === 'CLAUDE_CONFIG_DIR' ? path.join(SANDBOX_HOME, '.claude') : SANDBOX_HOME;
  return { ...out, ...extra };
}
function run(cwd, args, envExtra = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: sandboxedEnv(envExtra) });
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
// 08a: this test used to write journal.outputDirectory then atomicityRetries into the PROJECT config; the project layer may no longer set outputDirectory (the loader ignores it,
// configure refuses it, tests below), so the sibling pair is the update group's two project-writable keys. The behaviour under test (no sibling clobbered) is unchanged.
test('a nested write does NOT clobber a sibling key already in the same group', (t) => {
  const dir = sandboxProject(t);
  let r = run(dir, ['--update.updateMode', 'remind']);
  assert.equal(r.status, 0);
  r = run(dir, ['--update.updateCheckDays', '20']);
  assert.equal(r.status, 0);
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.deepEqual(cfg.update, { updateMode: 'remind', updateCheckDays: 20 });
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

// 08a: the only string key is global-only now, so the string type is exercised through --global (a project run is refused, tests below).
test('string type: any string value parsed as-is -- the case neither exemplar needed', (t) => {
  const dir = sandboxProject(t);
  const homeDir = sandboxHome(t);
  const r = run(dir, ['--global', '--journal.outputDirectory', 'somewhere/else'], { CLAUDE_CONFIG_DIR: homeDir });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, '.coalhearth.json'), 'utf8')).journal.outputDirectory, 'somewhere/else');
});

// ---------------------------------------------------------------- 08a: journal.outputDirectory is GLOBAL-ONLY (BB-49 (1), UMB-456)
// The loader IGNORES a project value for this key (hooks-safety.md section 9), so a project write would be a value that does nothing. It is refused, loudly, before anything is written.
test('08a: --journal.outputDirectory on the PROJECT config is refused, names --global, and writes NOTHING', (t) => {
  const dir = sandboxProject(t);
  const r = run(dir, ['--journal.outputDirectory', 'src']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--journal.outputDirectory'), r.stderr);
  assert.match(r.stderr, /--global/);
  assert.equal(fs.existsSync(ownDirConfig(dir)), false, 'no config file was created');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false, 'not even the directory');
});

test('08a: the refusal covers the WHOLE invocation -- a valid flag beside it is not written either, and an existing config is untouched', (t) => {
  const dir = sandboxProject(t);
  const p = ownDirConfig(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const before = JSON.stringify({ language: 'en' });
  fs.writeFileSync(p, before);
  const r = run(dir, ['--journal.atomicityRetries', '2', '--journal.outputDirectory', 'src']);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'the existing file is byte-exact');
});

test('08a: --global still writes journal.outputDirectory, and the help names it as global-only', (t) => {
  const dir = sandboxProject(t);
  const homeDir = sandboxHome(t);
  const r = run(dir, ['--global', '--journal.outputDirectory', '.claude/custom'], { CLAUDE_CONFIG_DIR: homeDir });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeDir, '.coalhearth.json'), 'utf8')).journal.outputDirectory, '.claude/custom');
  assert.equal(fs.existsSync(ownDirConfig(dir)), false, 'the project config is untouched');
  const h = run(dir, ['--help']);
  const row = h.stdout.split(String.fromCharCode(10)).find((l) => l.includes('--journal.outputDirectory ') && l.includes('Where session_handoff.json'));
  assert.ok(row && /global/i.test(row), 'the help row says the key is set in the global config only: ' + row);
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
// R19 FIXBACK 1: these three tests are about the migration and its announcement, not about git. Their sandbox used to carry an EMPTY `.git` directory, which git
// answers with exit 128 and the migration used to read as "no repository" (so the legacy file was removed). A `.git` entry with git answering 128 now means a
// repository git refuses and KEEPS the file, so the anchor is a REAL repository where the legacy file is untracked. With no git binary the empty directory is
// still enough (nothing to ask, the file is removed).
function migrationProject(t) { return haveGit ? realRepo(t) : sandboxProject(t); }
test('a config found at the LEGACY root path migrates to the own-dir default on write', (t) => {
  const dir = migrationProject(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(legacy), false, 'the legacy file is removed after a successful migrated write');
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.equal(cfg.language, 'zh');
});

// The announcement is asserted by IDENTITY, not by spelling. configure.mjs names the path its own
// root walk produced -- findProjectRoot realpaths the start dir, so it is the PHYSICAL spelling --
// while a test builds its paths from os.tmpdir(), which on macOS is /var/... (a symlink to
// /private/var/...). Same directory, two spellings: a raw substring compare fails there and
// only there (CI run 35667279997). Both sides go through ONE resolver, realpath.native
// (node/runtime.md 4 -- this is an identity question, "are these the same place?"). The file the
// migration removed no longer exists, so the legacy path is compared by its surviving directory
// plus its exact basename; the canonical file it wrote is compared whole. Still checks BOTH the
// source and the destination the user is told about -- stronger than the substring it replaces,
// which never looked at the destination.
const sameDir = (a, b) => fs.realpathSync.native(a) === fs.realpathSync.native(b);
function announcedMigration(stdout) {
  const m = /^Migrated the project config from (.+?\.coalhearth\.json) to (.+?coalhearth\.json)\.\s*$/m.exec(stdout);
  return m ? { from: m[1], to: m[2] } : null;
}
function assertMigrationAnnounced(stdout, legacyPath, canonicalPath) {
  const a = announcedMigration(stdout);
  assert.ok(a, 'the migration is announced (a "Migrated the project config from <legacy> to <canonical>." line): ' + JSON.stringify(stdout));
  assert.equal(path.basename(a.from), path.basename(legacyPath), 'names the legacy file it read');
  assert.ok(sameDir(path.dirname(a.from), path.dirname(legacyPath)), 'the legacy path it names is in the same directory, however that is spelled: ' + a.from);
  assert.ok(sameDir(a.to, canonicalPath), 'the canonical path it names is the file it wrote, however that is spelled: ' + a.to);
}

// UMB-133: the nested legacy shape is now a READ candidate, so a write that found its config
// there must migrate exactly like the root legacy does -- write the canonical file, remove the
// legacy one -- instead of quietly rewriting the deprecated path in place.
test('UMB-133: a config found at the NESTED legacy path migrates to the own-dir default on write', (t) => {
  const dir = migrationProject(t);
  const nested = path.join(dir, '.claude', '.coalhearth.json');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, JSON.stringify({ language: 'auto' }));
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(nested), false, 'the nested legacy file is removed after a successful migrated write');
  const cfg = JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8'));
  assert.equal(cfg.language, 'zh');
  assertMigrationAnnounced(r.stdout, nested, ownDirConfig(dir));
});

// The macOS class (CI run 35667279997), reproducible on ANY box: the sandbox is spelled through
// a directory link (macOS: /var -> /private/var; here a junction/symlink) while configure.mjs
// announces the path its own root walk produced -- the PHYSICAL one. Capability is PROBED (a
// link that cannot be created skips visibly), never guessed from process.platform.
test('UMB-133 (macOS class): the migration announcement holds when the sandbox is spelled through a directory link', (t) => {
  const real = migrationProject(t);
  const link = real + '-link';
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch (e) {
    t.skip('cannot create a directory link here: ' + e.code);
    return;
  }
  t.after(() => { try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch {} } });
  const nested = path.join(link, '.claude', '.coalhearth.json');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, JSON.stringify({ language: 'auto' }));
  const r = run(link, ['--language', 'zh']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(nested), false, 'the legacy file is removed');
  const canonical = path.join(link, '.claude', 'coal', 'coalhearth.json');
  assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).language, 'zh');
  assertMigrationAnnounced(r.stdout, nested, canonical);
  // Guard against a vacuous pass: the sandbox really is spelled two ways here, and the
  // announcement is the physical one. If this ever stops holding the test proves nothing.
  const a = announcedMigration(r.stdout);
  assert.notEqual(path.dirname(a.from), path.dirname(nested), 'the announcement is the physical spelling, not the link one');
});

// CWK-120 ride-along (a): a parsed body that is not a plain object is NEVER accepted as the config. configure.mjs is
// a WRITER, so the old `parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}` was worse than a
// silent read: a config file holding `[]`, `"str"`, `42`, `null` or `true` was treated as an EMPTY config, exit 0,
// and OVERWRITTEN with no backup and no notice -- a user's file replaced without a word. It now takes the same
// recovery a malformed body takes (back up to .bak, rebuild from defaults, exit 1), with a message that says WHAT
// was wrong. The conductor's own parse (lib/load-config.js readConfigFile) already refuses a non-object and REPORTS it
// as the UMB-174 (b) reason "not a JSON object" (UNREADABLE line); it never merges one either.
for (const body of ['[]', '["a","b"]', '"str"', '42', 'null', 'true']) {
  test('CWK-120 (a): a config file holding ' + body + ' is backed up + rebuilt, never accepted or merged into (exit 1)', (t) => {
    const dir = sandboxProject(t);
    const p = ownDirConfig(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    const r = run(dir, ['--language', 'en']);
    assert.equal(r.status, 1, 'a non-object body reports the non-zero it found, like a malformed one: ' + r.stdout + r.stderr);
    assert.equal(fs.readFileSync(p + '.bak', 'utf8'), body, 'the ORIGINAL file is preserved byte-for-byte in .bak, not silently lost');
    assert.match(r.stderr, /not a JSON object/, 'the warning names what was wrong');
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { language: 'en' }, 'rebuilt from defaults + the requested flag only -- no array element or scalar merged in');
  });
}

test('CWK-120 (a): the same guard on the GLOBAL layer (--global)', (t) => {
  const dir = sandboxProject(t);
  const home = sandboxHome(t);
  const g = path.join(home, '.coalhearth.json');
  fs.writeFileSync(g, '[1,2,3]');
  const r = run(dir, ['--global', '--language', 'th'], { CLAUDE_CONFIG_DIR: home });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(g + '.bak', 'utf8'), '[1,2,3]');
  assert.deepEqual(JSON.parse(fs.readFileSync(g, 'utf8')), { language: 'th' });
});

// R8 FIXBACK L4 (the head's ruling on pending decision 2): keep backup-and-rebuild for a malformed or non-object body,
// but NEVER write when the backup did not land. The branch was pre-existing for malformed bodies (warn "Overwriting"
// and write anyway); the R8 belt made it reachable for a new body class and the CHANGELOG promised "always backed up".
// INSPECT's shape: a [1,2] config beside a .bak that is a DIRECTORY -- the backup copy throws.
for (const [what, body] of [['a non-object body', '[1,2]'], ['a malformed body', '{ this is not json'], ['a JSON string body', '"str"']]) {
  test('L4: ' + what + ' whose .bak cannot be written is REFUSED -- nothing written, the original byte-exact, exit 1, a message that says why and what to do', (t) => {
    const dir = sandboxProject(t);
    const p = ownDirConfig(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    fs.mkdirSync(p + '.bak'); // the backup target is a directory: copyFileSync throws
    const r = run(dir, ['--language', 'th']);
    assert.equal(r.status, 1, 'exit 1: ' + r.stdout + r.stderr);
    assert.equal(fs.readFileSync(p, 'utf8'), body, 'the ORIGINAL is byte-exact -- nothing was written');
    assert.ok(fs.statSync(p + '.bak').isDirectory(), 'the .bak path was left alone');
    assert.doesNotMatch(r.stdout, /Successfully updated/, 'no success line for a write that did not happen');
    assert.match(r.stderr, /not written|nothing was written/i, 'says what happened');
    assert.match(r.stderr, /\.bak/, 'names the backup path');
    assert.match(r.stderr, /remove|rename|free|permission/i, 'says what to do next (Standard System 4)');
  });
}

test('L4: the same refusal on the GLOBAL layer (--global)', (t) => {
  const dir = sandboxProject(t);
  const home = sandboxHome(t);
  const g = path.join(home, '.coalhearth.json');
  fs.writeFileSync(g, '[1,2,3]');
  fs.mkdirSync(g + '.bak');
  const r = run(dir, ['--global', '--language', 'th'], { CLAUDE_CONFIG_DIR: home });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(g, 'utf8'), '[1,2,3]');
  assert.doesNotMatch(r.stdout, /Successfully updated/);
});

test('L4: a backup that DOES land is unchanged behaviour -- .bak holds the original, the file is rebuilt, exit 1', (t) => {
  const dir = sandboxProject(t);
  const p = ownDirConfig(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '[1,2]');
  const r = run(dir, ['--language', 'th']);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(p + '.bak', 'utf8'), '[1,2]');
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { language: 'th' });
});

// ---------------------------------------------------------------- R19 (CodeRabbit PR #19 thread 14): the migration never deletes a file git TRACKS
// A root `.coalhearth.json` is often a team-shared, committed file. The migrated write used to rmSync it unconditionally, so the next
// `git commit -a` removed it for the whole team. Now a tracked legacy file is KEPT and the user is told to `git rm` it after review;
// it is removed only when it is untracked or there is no repository or no git binary (no-external-assumption: git is optional).
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, env: gitEnv() });
const haveGit = (() => { const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 30000, env: gitEnv() }); return !r.error && r.status === 0; })();
// A REAL repository (the other sandboxes carry an empty .git directory, which git reads as "not a repository").
function realRepo(t) {
  const dir = sandboxProject(t);
  fs.rmdirSync(path.join(dir, '.git'));
  assert.equal(git(dir, ['init', '-q']).status, 0, 'fixture: git init');
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'fixture: the sandbox carries its OWN .git before anything runs against it');
  return dir;
}

test('R19: a legacy config that git TRACKS is kept after the migrated write, with a git rm line (exit 0)', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const dir = realRepo(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  assert.equal(git(dir, ['add', '--', '.coalhearth.json']).status, 0, 'fixture: tracked');
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), true, 'the tracked legacy file is KEPT');
  assert.equal(JSON.parse(fs.readFileSync(ownDirConfig(dir), 'utf8')).language, 'zh', 'the canonical config was still written');
  assert.match(r.stdout, /git rm -- \.coalhearth\.json/, 'the user is told what to run after review: ' + r.stdout);
  assert.doesNotMatch(r.stdout, /^Migrated the project config from/m, 'and is not told the legacy file was migrated away');
});

test('R19: a legacy config that is UNTRACKED in a real repository is still removed by the migrated write', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const dir = realRepo(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' })); // present, never added
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), false, 'an untracked legacy file is removed, as before');
  assertMigrationAnnounced(r.stdout, legacy, ownDirConfig(dir));
});

test('R19: with NO git binary on the PATH the migration degrades to the old behaviour (the legacy file is removed)', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const dir = realRepo(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  assert.equal(git(dir, ['add', '--', '.coalhearth.json']).status, 0, 'fixture: tracked');
  const r = run(dir, ['--language', 'zh'], { PATH: path.join(dir, 'no-such-bin'), Path: path.join(dir, 'no-such-bin') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), false, 'no git to ask: documented degrade, the file is removed as before');
});

// The project root is not always the repository root: a config FILE is itself a root marker (config-load.mjs ROOT_MARKERS), so a project
// directory inside a bigger repository is a normal layout. git must be asked as a repository ABOVE the project would answer, with no
// ceiling at the project root's parent, or a tracked legacy config in a monorepo subdirectory would read as untracked and be deleted.
test('R19: a tracked legacy config in a SUBDIRECTORY of a bigger repository (the project root is not the repo root) is kept', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const repo = realRepo(t);
  const proj = path.join(repo, 'proj');
  fs.mkdirSync(proj);
  const legacy = path.join(proj, '.coalhearth.json'); // also the root marker that anchors the project here
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  assert.equal(git(repo, ['add', '--', 'proj/.coalhearth.json']).status, 0, 'fixture: tracked by the enclosing repository');
  const r = run(proj, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), true, 'kept: the enclosing repository tracks it');
  assert.match(r.stdout, /git rm -- \.coalhearth\.json/, r.stdout);
});

// R19 FIXBACK 1, MEDIUM-1: git exits 128 for EVERY fatal error, not only "not a git repository". A repository git refuses to read (dubious ownership, a corrupt
// .git) answers 128 for a file it tracks, and 128 was read as "no repository", so the tracked legacy file was still deleted. 128 now means "no repository" only when no
// `.git` entry exists above the project at all, decided with fs and never by matching git's localised stderr; any other 128 is unknown and KEEPS the file.
test('R19 FIXBACK: a tracked legacy config in a repository git REFUSES (garbage HEAD, git exits 128) is KEPT, never read as "no repository"', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const dir = realRepo(t);
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  assert.equal(git(dir, ['add', '--', '.coalhearth.json']).status, 0, 'fixture: tracked');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'garbage\n'); // the repository is now one git refuses to read
  assert.equal(git(dir, ['ls-files', '--error-unmatch', '--', '.coalhearth.json']).status, 128, 'fixture: git answers 128 for it');
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), true, 'kept: 128 here is a repository git refuses, not the absence of one');
  assert.match(r.stdout, /could not be asked/, r.stdout);
  assert.match(r.stdout, /git rm -- \.coalhearth\.json/, r.stdout);
});

test('R19 FIXBACK: a garbage .git FILE (git exits 128) also KEEPS the legacy file', (t) => {
  const dir = sandboxProject(t);
  fs.rmdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git'), 'not a gitfile\n');
  const legacy = path.join(dir, '.coalhearth.json');
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), true, 'a .git entry exists, so nothing says there is no repository');
  assert.match(r.stdout, /could not be asked/, r.stdout);
});

test('R19 FIXBACK: with NO .git entry anywhere above the project, git exits 128 and the legacy file is removed as before', (t) => {
  const dir = sandboxProject(t);
  fs.rmdirSync(path.join(dir, '.git'));
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { t.skip('a .git entry exists above the temp root on this box: ' + d); return; }
    if (path.dirname(d) === d) break;
  }
  const legacy = path.join(dir, '.coalhearth.json'); // also the root marker that anchors the project here
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  const r = run(dir, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), false, 'no repository at all: nothing to protect');
  assertMigrationAnnounced(r.stdout, legacy, ownDirConfig(dir));
});

test('R19 FIXBACK: the .git entry is looked for ABOVE the project too (a refused repository around a project subdirectory keeps the legacy file)', (t) => {
  if (!haveGit) { t.skip('git is not available here'); return; }
  const repo = realRepo(t);
  const proj = path.join(repo, 'proj');
  fs.mkdirSync(proj);
  const legacy = path.join(proj, '.coalhearth.json'); // the root marker that anchors the project at proj
  fs.writeFileSync(legacy, JSON.stringify({ language: 'auto' }));
  assert.equal(git(repo, ['add', '--', 'proj/.coalhearth.json']).status, 0, 'fixture: tracked by the enclosing repository');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'garbage\n');
  const r = run(proj, ['--language', 'zh']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(legacy), true, 'kept: the .git entry sits in the parent, and git refuses it');
  assert.match(r.stdout, /could not be asked/, r.stdout);
});

// R20 (the sweep for the class of CodeRabbit PR #19 thread 20): run() handed configure.mjs the parent's environment, so a --global run that forgot its own CLAUDE_CONFIG_DIR wrote
// the OPERATOR's real global config. The parent's value stands in for it here, a throwaway directory; the child must never write there.
test('R20: a --global run that passes no CLAUDE_CONFIG_DIR of its own never touches the parent\'s (the operator\'s) global config directory', (t) => {
  const projectDir = sandboxProject(t);
  const operatorDir = sandboxHome(t);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
  process.env.CLAUDE_CONFIG_DIR = operatorDir;
  const r = run(projectDir, ['--global', '--update.updateMode', 'remind']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(operatorDir), [], 'the operator\'s config directory was not written');
});
