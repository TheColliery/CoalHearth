import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProjectRoot, projectConfigPath, loadMergedConfig } from './config-load.mjs';

function mkSandboxHome() {
  // realpath the sandbox: findProjectRoot compares PHYSICAL paths (macOS tmpdir is a
  // /var -> /private/var symlink), so the test's dirs must be physical to agree on every OS.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-test-')));
}

test('findProjectRoot stops at home and never walks above it', () => {
  const home = mkSandboxHome();
  const deep = path.join(home, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  const root = findProjectRoot(deep, home);
  assert.equal(path.resolve(root), path.resolve(deep)); // no .git/.coalhearth.json found -> falls back to startDir
  fs.rmSync(home, { recursive: true, force: true });
});

test('findProjectRoot finds a .coalhearth.json marker above cwd but below home', () => {
  const home = mkSandboxHome();
  const projectDir = path.join(home, 'proj');
  const deep = path.join(projectDir, 'src', 'nested');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), '{}');
  const root = findProjectRoot(deep, home);
  assert.equal(path.resolve(root), path.resolve(projectDir));
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadMergedConfig merges project over global per group, never throws on missing files', () => {
  const home = mkSandboxHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), JSON.stringify({ budgets: { maxTurns: 30, maxTokens: 100 } }));
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.coalhearth.json'), JSON.stringify({ budgets: { maxTurns: 99 } }));
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal(merged.budgets.maxTurns, 99); // project wins
  assert.equal(merged.budgets.maxTokens, 100); // global key survives shallow merge
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadMergedConfig returns {} when neither file exists (never throws)', () => {
  const home = mkSandboxHome();
  const cwd = path.join(home, 'empty');
  fs.mkdirSync(cwd, { recursive: true });
  assert.deepEqual(loadMergedConfig({ cwd, home }), {});
  fs.rmSync(home, { recursive: true, force: true });
});

test('projectConfigPath composes root + filename', () => {
  const home = mkSandboxHome();
  const p = projectConfigPath(home, home);
  assert.equal(path.basename(p), '.coalhearth.json');
  fs.rmSync(home, { recursive: true, force: true });
});

test('loadMergedConfig is prototype-pollution safe (a poisoned project config cannot touch Object.prototype)', () => {
  const home = mkSandboxHome();
  const projectDir = path.join(home, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  // A poisoned project .coalhearth.json (as an untrusted cloned repo might ship): a
  // TOP-LEVEL __proto__ group (unguarded -> merged['__proto__']=... [[Set]] pollution) and
  // a NESTED one inside a real group.
  fs.writeFileSync(
    path.join(projectDir, '.coalhearth.json'),
    '{ "__proto__": { "polluted": true }, "budgets": { "__proto__": { "polluted2": true }, "maxTurns": 5 } }'
  );
  const merged = loadMergedConfig({ cwd: projectDir, home });
  assert.equal({}.polluted, undefined, 'Object.prototype NOT polluted (top-level __proto__)');
  assert.equal({}.polluted2, undefined, 'Object.prototype NOT polluted (nested __proto__)');
  assert.equal(merged.budgets.maxTurns, 5, 'legit keys still load past the guard');
  assert.equal(Object.prototype.hasOwnProperty.call(merged, '__proto__'), false, '__proto__ dropped from the merged config');
  fs.rmSync(home, { recursive: true, force: true });
});
