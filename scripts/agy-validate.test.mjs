// The Antigravity route (08b; r29b): the AG manifest carries the marketplace fields, and agy's own validator reads the built
// plugin with no error and no missing-logo note. agy is probed, never decided by platform: where it is not on PATH the test skips VISIBLY.
// Strict mode cannot pass on this dist: plugin/ ships commands/ and hooks/hooks.json for the Claude Code route, and the AG
// validator names both as never loaded. So the test pins the warnings to exactly those two named entries and fails on any other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAgy, validateAgyPlugin, agyEnv } from './lib/agy-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(repo, 'plugin');
const AGY_TIMEOUT_MS = 120000;
const NAMED_WARNING_FILES = ['commands', 'hooks/hooks.json'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// One `agy plugin validate --json` run, checked, returning its findings. The spawn is injectable, so the witnesses below drive
// the same checks with a stub run (a non-zero exit with a clean-looking report must fail).
function validateLeg({ env, spawn }) {
  const r = validateAgyPlugin({ pluginDir: PLUGIN, env, timeoutMs: AGY_TIMEOUT_MS, spawn });
  assert.equal(r.error, undefined, `agy plugin validate did not run: ${r.error && r.error.code}`);
  // A non-zero exit or a signal kill is a failed run, whatever its report says: agy can print a clean report and still fail.
  assert.equal(r.signal, null, `agy plugin validate was killed by ${r.signal}`);
  assert.equal(r.status, 0, `agy plugin validate exited ${r.status}`);
  let report;
  try { report = JSON.parse(r.stdout); } catch (e) {
    assert.fail(`agy plugin validate printed no JSON report (exit ${r.status}): ${e.message}\n${r.stdout}\n${r.stderr}`);
  }
  const all = report.findings || [];
  assert.deepEqual(
    all.filter((f) => f.severity === 'error').map((f) => `${f.file}: ${f.message}`), [],
    'agy reports error entries on the built plugin',
  );
  assert.equal(all.some((f) => /no logo/.test(f.message)), false, 'agy still reports no logo');
  const warnings = all.filter((f) => f.severity === 'warning').map((f) => f.file).sort();
  assert.deepEqual(warnings, [...NAMED_WARNING_FILES].sort(), 'AG warnings differ from the named set');
  return all;
}

// The report a clean run prints for the built dist: the two named warnings and nothing else.
const CLEAN_REPORT = JSON.stringify({
  name: 'coalhearth',
  components: { agents: 0, hooks: 1, mcpServers: 0, rules: 0, sidecars: 0, skills: 0 },
  findings: [
    { severity: 'warning', file: 'commands', message: 'never loaded: plugins have no commands' },
    { severity: 'warning', file: 'hooks/hooks.json', message: 'never loaded: plugin hooks are read only from hooks.json at the plugin root' },
  ],
});
const stubRun = (over) => () => ({ status: 0, signal: null, error: undefined, stdout: CLEAN_REPORT, stderr: '', ...over });

test('the AG manifest carries the marketplace fields and the Claude Code version', () => {
  const ag = readJson(path.join(repo, 'plugin.json'));
  const claude = readJson(path.join(repo, '.claude-plugin', 'plugin.json'));
  for (const key of ['displayName', 'description', 'version', 'logo', 'author']) {
    assert.ok(ag[key], `plugin.json has no ${key}`);
  }
  assert.equal(ag.version, claude.version, 'AG and Claude Code manifests disagree on version');
  assert.ok(fs.existsSync(path.join(repo, ag.logo)), `logo ${ag.logo} is not in the repo`);
});

test('the validate leg accepts a clean run (exit 0, the named warnings only)', () => {
  assert.equal(validateLeg({ env: {}, spawn: stubRun({}) }).length, 2);
});

test('the validate leg fails a run that exits 1 even when its report reads clean', () => {
  assert.throws(() => validateLeg({ env: {}, spawn: stubRun({ status: 1, stderr: 'agy: failed after printing the report' }) }), /exited 1/);
});

test('the validate leg fails a run killed by a signal even when its report reads clean', () => {
  assert.throws(() => validateLeg({ env: {}, spawn: stubRun({ status: null, signal: 'SIGKILL' }) }), /SIGKILL/);
});

test('agy validate: the built plugin has no error, no missing-logo note, and only the named warnings', (t) => {
  // agy writes .gemini/config under HOME, so the run gets a temp HOME, removed after.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coalhearth-agyval-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = agyEnv(home);
  // Skip ONLY when agy is absent; a probe that hangs or fails is a failure, not a skip.
  const probe = probeAgy({ timeoutMs: AGY_TIMEOUT_MS, env });
  if (probe.state === 'absent') { t.skip('agy not on PATH: AG plugin validation not run'); return; }
  assert.equal(probe.state, 'present', `agy probe failed (not a skip): ${probe.reason}`);
  validateLeg({ env });
});
