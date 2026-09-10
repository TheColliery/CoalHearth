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

function run(tmp) {
  return spawnSync(process.execPath, [path.join(tmp, 'scripts', 'verify.mjs')], { cwd: tmp, encoding: 'utf8' });
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
  const opts = { cwd: tmp, encoding: 'utf8' };
  spawnSync('git', ['init', '-q', '.'], opts);
  // Local, throwaway identity -- never touches the operator's own global git config.
  spawnSync('git', ['config', 'user.email', 'ci@coalhearth.invalid'], opts);
  spawnSync('git', ['config', 'user.name', 'coalhearth-verify-test'], opts);
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-q', '-m', 'fixture'], opts);
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
    spawnSync('git', ['config', 'core.bare', 'true'], { cwd: tmp, encoding: 'utf8' });

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
