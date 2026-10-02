// Hermetic negative-path test for scripts/verify.mjs itself (scripts-quality.md §2:
// "the verify gate must have at least one automated negative-path test"). No prior
// test in this room spawned verify.mjs as a real subprocess -- every other check it
// performs is exercised indirectly (checkDist via build-plugin.test.mjs, the schema
// merge via config-schema.test.mjs, etc.), so this file's scope is narrow: prove the
// board #64 addition (plugin.json's OWN description vs DESC_CAP) actually gates, by
// running the real gate against a full tmp copy of the repo, exactly as a user's
// pre-commit hook would.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from './lib/git-env.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-verify-test-'));
}

// Everything verify.mjs actually reads: the shipped dirs, scripts/ (its own lib
// imports + build-plugin.mjs's checkDist), plugin/ (the dist-parity check),
// .github/ISSUE_TEMPLATE (the version-pin check), and .githooks/ (a hash-comments
// pointer-drift surface -- r31 fixback, added so the git-fixture tests below exercise
// a genuinely non-empty hash-comments row rather than always reading 0 from an absent dir).
const COPY_DIRS = ['bin', 'lib', 'config', 'hooks', 'commands', '.claude-plugin', 'platform-configs', 'scripts', 'plugin', '.github', '.githooks'];
// Root DOCS the config-key gate (CWK-060) names as hand-picked surfaces. Added when that gate
// landed and this fixture went RED on its own incompleteness -- the sandbox copied directories
// only, so every root .md was absent and the gate correctly reported a wiring bug. That red is
// the fix working: an incomplete fixture used to look identical to a passing one.
// CHANGELOG.md added (r31 fixback) so the pointer-drift block's historyOnly row reads cleanly
// instead of a "could not read" SKIP -- harmless either way, but a clean read matches production.
const COPY_FILES = ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];

function seed(tmp) {
  for (const d of COPY_DIRS) fs.cpSync(path.join(repo, d), path.join(tmp, d), { recursive: true });
  for (const f of COPY_FILES) fs.cpSync(path.join(repo, f), path.join(tmp, f));
}

function run(tmp, env) {
  return spawnSync(process.execPath, [path.join(tmp, 'scripts', 'verify.mjs')], { cwd: tmp, encoding: 'utf8', ...(env ? { env } : {}) });
}

test('verify.mjs negative path: an over-cap .claude-plugin/plugin.json description FAILs the gate', () => {
  const tmp = mkTmp();
  try {
    seed(tmp);

    const clean = run(tmp);
    assert.equal(clean.status, 0, `pristine copy must PASS, got:\n${clean.stdout}${clean.stderr}`);

    const pluginJsonPath = path.join(tmp, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    pj.description = 'x'.repeat(1025);
    fs.writeFileSync(pluginJsonPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const over = run(tmp);
    assert.equal(over.status, 1, 'a plugin.json description over 1024 chars must FAIL with exit 1');
    assert.match(over.stdout, /\.claude-plugin\/plugin\.json: description 1025 chars exceeds the 1024-char cap/,
      'the FAIL line names the file, the exact length, and the cap');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verify.mjs negative path: a truthy non-string plugin.json description FAILs loud, never silently 0 chars', () => {
  const tmp = mkTmp();
  try {
    seed(tmp);

    const pluginJsonPath = path.join(tmp, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    pj.description = 123; // truthy, non-string -- the shape a CoalBoard sibling found slipping the exemplar's guard
    fs.writeFileSync(pluginJsonPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const r = run(tmp);
    assert.equal(r.status, 1, 'a non-string description must FAIL, not silently pass as 0 chars');
    assert.match(r.stdout, /\.claude-plugin\/plugin\.json: description is not a string \(got number\)/,
      'the FAIL line names the actual type found');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// r31 FINDINGS-BACK HIGH: no test above ever ran verify.mjs INSIDE A GIT REPO -- every prior
// test's fixture is a plain file/dir copy with no `.git`, so the pointer-drift block's own
// wiring (CWK-079's ignoredRoots probe, CWK-090's fail-open fix, fix 3's surface-plan adoption)
// took the NAMED SKIP every time and nothing exercised it. These two tests give it a real git
// fixture; INSPECT's own two mutations (fail: () => {} at the verify.mjs call site, and dropping
// the comments/hash-comments rows out of collectSurfaces) are the ones proven to redden them --
// see the coder's own return for the mutation log, not restated here.
function gitInit(tmp) {
  // CWK-133: the whole GIT_* family stripped and a ceiling at the sandbox's parent, so a hook
  // that exported an absolute GIT_DIR (a linked worktree's) can never redirect this fixture onto
  // the real enclosing repo.
  // One spawn site with an explicit env: (the census, CWK-136, reads it -- a shared `opts` object
  // would hide the env from it).
  const g = (args) => spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env: gitEnv(path.dirname(tmp)) });
  g(['init', '-q', '.']);
  // Local, throwaway identity -- never touches the operator's own global git config.
  g(['config', 'user.email', 'ci@coalhearth.invalid']);
  g(['config', 'user.name', 'coalhearth-verify-test']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'fixture']);
}

// INDEPENDENT of collectSurfaces() and of DEFAULT_SURFACE_PLAN's own code -- a mutation to
// EITHER (the plan's rows, or collectSurfaces' handling of a `kind`) must not also mutate what
// this function expects, or the comparison in the surface-count test below is vacuous by
// construction (the exact trap INSPECT's LOW named for fix 2's own test). This re-derives the
// plan's declared shape by hand, walking the SAME fixture tree with plain fs calls.
function expectedSurfaceCount(tmp) {
  const countRecursive = (dir, keep) => {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += countRecursive(p, keep);
      else if (keep(e.name)) n += 1;
    }
    return n;
  };
  const NOT_TEST_MJS = (n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs');
  const NOT_TEST_JS = (n) => n.endsWith('.js') && !n.endsWith('.test.js');
  const rawRows = 7; // README, SECURITY, PRIVACY, CONTRIBUTING, platform-configs/hooks/README.md,
                      // platform-configs/.coalhearth.json, CHANGELOG.md -- one surface EACH,
                      // even unreadable (collectSurfaces pushes unconditionally for a non-dir row).
  return rawRows
    + countRecursive(path.join(tmp, 'commands'), (n) => n.endsWith('.md'))
    + countRecursive(path.join(tmp, 'scripts'), NOT_TEST_MJS)
    + countRecursive(path.join(tmp, 'bin'), NOT_TEST_JS)
    + countRecursive(path.join(tmp, 'lib'), NOT_TEST_JS)
    + countRecursive(path.join(tmp, '.githooks'), () => true);
}

test('verify.mjs pointer-drift block RUNS under a real git repo, and the walked-surface count matches the plan independently of collectSurfaces', () => {
  const tmp = mkTmp();
  try {
    seed(tmp);
    gitInit(tmp);

    const r = run(tmp);
    assert.equal(r.status, 0, `a pristine committed fixture must PASS, got:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /pointer drift NOT CHECKED/,
      'a real git repo must not take the no-.git NAMED SKIP');

    const m = r.stdout.match(/ok {3}every path this repo points at from (\d+) surface\(s\)/);
    assert.ok(m, `the pointer-drift ok line must print with a surface count, got:\n${r.stdout}`);
    assert.equal(Number(m[1]), expectedSurfaceCount(tmp),
      'the walked-surface count must equal the plan\'s own rows, independently counted -- a mutation dropping the comments/hash-comments rows out of collectSurfaces (or out of the plan) must show up as a SMALLER printed count than this fixed expectation, never a silent collapse nobody notices');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verify.mjs pointer-drift block FAILs loud when git check-ignore cannot run, never silently reports a clean pass', () => {
  const tmp = mkTmp();
  try {
    seed(tmp);
    gitInit(tmp);

    // core.bare=true AFTER the commit: `git ls-files` keeps answering from the already-built
    // index (the tracked-file list stays correct, so this is not the untracked-noise shape),
    // while `git check-ignore --stdin` refuses outright -- "fatal: this operation must be run
    // in a work tree", exit 128. A REAL git behaviour, identical on every OS, needing no PATH
    // shim: measured on this box that a bare `spawnSync('git', …)` (no shell:true) silently
    // bypasses a PATH-prepended .cmd/shebang git shim and resolves straight to the real
    // binary regardless of PATH order (r31 BUILD1) -- core.bare sidesteps that dead end
    // entirely by making the REAL git binary itself the one that refuses.
    spawnSync('git', ['config', 'core.bare', 'true'], { cwd: tmp, encoding: 'utf8', env: gitEnv(path.dirname(tmp)) });

    const r = run(tmp);
    assert.equal(r.status, 1,
      `a check-ignore spawn that cannot run must FAIL the whole gate, got exit ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /VERIFY: FAIL/);
    assert.doesNotMatch(r.stdout, /VERIFY: PASS/,
      'the gate must never report a clean pass when the check-ignore probe could not run at all');
    assert.match(r.stdout,
      /FAIL git check-ignore --stdin exited 128 -- fatal: this operation must be run in a work tree -- cannot tell which cited roots are gitignored/,
      'the classifier\'s own message must reach stdout, naming the exit status and the reason -- not a swallowed failure');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// CWK-133 -- the git fixtures and the gate's own git children must not follow an ambient
// absolute GIT_DIR. Inside a LINKED worktree a git hook exports one, and it overrides both cwd and
// GIT_CEILING_DIRECTORIES: a fixture's `git init` then re-initialises the REAL enclosing repo and
// its `git config` writes there (CoalFace measured core.bare=true on its own repo, 2026-09-23).
// The sandbox stands in for that enclosing repo. The redirect is universal; the core.bare FLIP is
// platform-conditional (CoalTipple f0b95b9), so this asserts the universal leg only and never
// depends on the flip.
// `bare` marks the enclosing repo core.bare=true AFTER its index is built: git ls-files still answers from
// the index, while git check-ignore refuses outright ("must be run in a work tree"), so a check-ignore
// spawn that follows the ambient GIT_DIR instead of THIS fixture fails loud -- the second git child the
// gate spawns is pinned by the same test as the first.
function mkSandboxRepo(t, { bare = false } = {}) {
  const sandbox = mkTmp();
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const g = (args) => spawnSync('git', args, { cwd: sandbox, encoding: 'utf8', env: gitEnv(path.dirname(sandbox)) });
  assert.equal(g(['init', '-q', '.']).status, 0, 'setup: the sandbox repo must init cleanly');
  fs.writeFileSync(path.join(sandbox, 'unrelated.txt'), 'not ours\n');
  assert.equal(g(['add', 'unrelated.txt']).status, 0, 'setup: the sandbox repo tracks one unrelated file');
  if (bare) assert.equal(g(['config', 'core.bare', 'true']).status, 0, 'setup: the sandbox repo is marked bare');
  return { sandbox, gitDir: path.join(sandbox, '.git'), configOf: () => fs.readFileSync(path.join(sandbox, '.git', 'config')) };
}

function plantGitDir(t, gitDir) {
  const saved = process.env.GIT_DIR;
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  process.env.GIT_DIR = gitDir;
}

test('CWK-133: the git fixture never touches another repo when an absolute GIT_DIR is ambient -- it gets its own .git, the other repo config is byte-unchanged', (t) => {
  const { gitDir, configOf } = mkSandboxRepo(t);
  const before = configOf();
  const fixture = mkTmp();
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  plantGitDir(t, gitDir);

  gitInit(fixture);

  assert.ok(before.equals(configOf()), 'the enclosing repo config must be byte-unchanged (a redirected fixture writes user.email/user.name into it)');
  assert.ok(fs.existsSync(path.join(fixture, '.git')), 'the fixture must get the .git its caller asked for, not be redirected onto the enclosing repo');
});

test('CWK-133: verify.mjs asks git about ITS OWN repo when an absolute GIT_DIR is ambient -- the gate is a git-hook child and must not follow it (ls-files AND check-ignore)', (t) => {
  const { gitDir } = mkSandboxRepo(t, { bare: true });
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  gitInit(tmp);

  const clean = run(tmp);
  assert.equal(clean.status, 0, `setup: a pristine committed fixture must PASS, got:\n${clean.stdout}${clean.stderr}`);

  const poisoned = run(tmp, { ...process.env, GIT_DIR: gitDir });
  assert.equal(poisoned.status, 0,
    `an ambient GIT_DIR must not change the verdict -- the tracked list must come from THIS fixture, not the enclosing repo:\n${poisoned.stdout}${poisoned.stderr}`);
  assert.doesNotMatch(poisoned.stdout, /UNTRACKED|NOT CHECKED/);
});

// CWK-136 -- the census in verify.mjs proves SAFETY, not presence. Presence alone passes
// `env: process.env`, which hands a linked-worktree hook's absolute GIT_DIR straight to the child.
// Each test plants a git spawn in a scratch copy of the tree and runs the REAL gate over it.
// The planted source is assembled from name parts so this file's own text never contains a literal
// spawn the census would read as real (verify.mjs walks scripts/**, tests included).
const PLANT_FN = 'spawn' + 'Sync';
function plantSpawn(tmp, envText) {
  const call = PLANT_FN + "('git', ['status'], { cwd: '.'" + (envText ? ', env: ' + envText : '') + ' });';
  const body = ['import { ' + PLANT_FN + " } from 'node:child_process';", '', call, ''].join('\n');
  fs.writeFileSync(path.join(tmp, 'scripts', 'zz-planted.test.mjs'), body);
}

test('CWK-136: the pristine tree passes the git-spawn census, and the gate PRINTS what it walked', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  const r = run(tmp);
  assert.equal(r.status, 0, `a pristine copy must PASS, got:\n${r.stdout}${r.stderr}`);
  const m = r.stdout.match(/ok {3}(\d+) git spawn\(s\) across (\d+) file\(s\)/);
  assert.ok(m, `the census must print its counts, got:\n${r.stdout}`);
  // 8 call SITES today (2 in verify.mjs, 1 in link-check.mjs, and the fixture helpers), down from the
  // 20 literal spawns CWK-133 found -- the fixtures were folded into one helper each. A floor, not an equality.
  assert.ok(Number(m[1]) >= 8, 'the census must see this room\'s git spawns, not walk an empty set');
  assert.ok(Number(m[2]) >= 20, 'the census must walk the scripts/, lib/ and bin/ trees');
});

test('CWK-136: a git spawn planted with env: process.env FAILs the gate, naming file:line', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  plantSpawn(tmp, 'process.env');
  const r = run(tmp);
  assert.equal(r.status, 1, `presence of an env: key is not safety -- must FAIL, got:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /VERIFY: FAIL/);
  assert.match(r.stdout, /FAIL scripts\/zz-planted\.test\.mjs:3 .*process\.env/);
});

test('CWK-136: a git spawn planted with NO env: key FAILs the gate, naming file:line', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  plantSpawn(tmp, '');
  const r = run(tmp);
  assert.equal(r.status, 1, `a bare git spawn must FAIL, got:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /FAIL scripts\/zz-planted\.test\.mjs:3 .*no 'env:'/);
});

test('CWK-136: a git spawn planted with env: gitEnv(...) passes the census', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  plantSpawn(tmp, 'gitEnv(dir)');
  const r = run(tmp);
  assert.equal(r.status, 0, `the safe shape must PASS, got:\n${r.stdout}${r.stderr}`);
});

// CWK-120 finding #11 (CodeRabbit, Trivial), verified at the live tree: the required-files list named
// bin/session-start.js and bin/post-tool-use.js but not bin/user-prompt-submit.js, the third Claude Code hook entry.
// hooks.json is only checked for the path as TEXT, the libs check never imports a hook entry, and checkDist derives
// its parity from the files that EXIST -- so deleting the entry point from source AND plugin/ produced no finding
// while hooks.json kept pointing at it. (The two ag-*.js entries are held by the pointer gate, which the CodeRabbit
// note itself observed: platform-configs/hooks/README.md cites both paths.)
test('CWK-120 #11: deleting bin/user-prompt-submit.js from source AND plugin/ FAILs the gate by name', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  assert.equal(run(tmp).status, 0, 'setup: a pristine copy passes');
  fs.rmSync(path.join(tmp, 'bin', 'user-prompt-submit.js'));
  fs.rmSync(path.join(tmp, 'plugin', 'bin', 'user-prompt-submit.js'));
  const r = run(tmp);
  assert.equal(r.status, 1, 'a missing hook entry point must FAIL, got:\n' + r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL bin\/user-prompt-submit\.js missing/);
});

// R8 FIXBACK M1: the gate's printed census line must not claim more than the instrument produced. The one
// deliberate hazard fixture (a spawn fed a poisoned GIT_DIR on purpose) is a NAMED, COUNTED, PRINTED exemption.
test('M1: the census line counts the exemption instead of claiming every spawn takes env from gitEnv() alone', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  const r = run(tmp);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = r.stdout.match(/ok {3}(\d+) git spawn\(s\) across (\d+) file\(s\).*: (\d+) take env from gitEnv\(\) alone, (\d+) exempt by name \(([^)]*)\)/);
  assert.ok(m, 'the ok line must split alone vs exempt, got:\n' + r.stdout);
  assert.equal(Number(m[3]) + Number(m[4]), Number(m[1]), 'alone + exempt = every counted spawn');
  assert.ok(Number(m[4]) >= 1, 'the hazard fixture is counted as exempt');
  assert.match(m[5], /git-env\.test\.mjs/, 'the exemption names its file');
  assert.doesNotMatch(r.stdout, /every one takes env from gitEnv\(\) alone/, 'the old blanket claim is gone');
});

test('M1: an exemption whose spawn is gone FAILs the gate as stale', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  const f = path.join(tmp, 'scripts', 'lib', 'git-env.test.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('env: env || gitEnv(root)', 'env: gitEnv(root)'));
  const r = run(tmp);
  assert.equal(r.status, 1, 'a stale exemption must FAIL, got:\n' + r.stdout);
  assert.match(r.stdout, /FAIL .*exemption.*no longer matches/i);
});

// R8 FIXBACK 2 LOW-1: the exemption is keyed to a COUNT, so a second spawn with the exempted expression in the
// same file FAILs the gate as surely as a stale exemption does (INSPECT's X2: it used to PASS and print "2 exempt").
test('L1: a second spawn with the exempted expression in the same file FAILs the gate', (t) => {
  const tmp = mkTmp();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  seed(tmp);
  const f = path.join(tmp, 'scripts', 'lib', 'git-env.test.mjs');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = "  const git = (cwd, args, env) => " + PLANT_FN + "('git', args, { cwd, encoding: 'utf8', env: env || gitEnv(root) });";
  assert.ok(src.includes(anchor), 'setup: the exempted spawn is where the test expects it');
  const second = "\n  const git2 = (cwd, args, env) => " + PLANT_FN + "('git', ['init'], { cwd, env: env || gitEnv(root) });";
  fs.writeFileSync(f, src.replace(anchor, anchor + second));
  const r = run(tmp);
  assert.equal(r.status, 1, 'the widened exemption must FAIL, got:\n' + r.stdout);
  assert.match(r.stdout, /FAIL .*git-env\.test\.mjs:\d+ .*allows 1 spawn/);
});
