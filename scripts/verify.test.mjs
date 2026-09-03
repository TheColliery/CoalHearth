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
// imports + build-plugin.mjs's checkDist), plugin/ (the dist-parity check), and
// .github/ISSUE_TEMPLATE (the version-pin check).
const COPY_DIRS = ['bin', 'lib', 'config', 'hooks', 'commands', '.claude-plugin', 'platform-configs', 'scripts', 'plugin', '.github'];
// Root DOCS the config-key gate (CWK-060) names as hand-picked surfaces. Added when that gate
// landed and this fixture went RED on its own incompleteness -- the sandbox copied directories
// only, so every root .md was absent and the gate correctly reported a wiring bug. That red is
// the fix working: an incomplete fixture used to look identical to a passing one.
const COPY_FILES = ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CONTRIBUTING.md'];

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
