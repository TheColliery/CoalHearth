// Run: node --test lib/load-config.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./load-config');

function mk() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-cfg-'));
}

test('no config anywhere -> empty object, never throws', () => {
  const cwd = mk();
  const home = mk();
  assert.doesNotThrow(() => {
    assert.deepStrictEqual(loadConfig({ cwd, home }), {});
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('project config found by walking up from a subdir', () => {
  const root = mk();
  const home = mk();
  fs.writeFileSync(path.join(root, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 5 } }));
  const sub = path.join(root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const cfg = loadConfig({ cwd: sub, home });
  assert.strictEqual(cfg.journal.atomicityRetries, 5);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('project overlays global, per-group shallow merge', () => {
  const home = mk();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.coalhearth.json'),
    JSON.stringify({ journal: { outputDirectory: '.claude/coalhearth', atomicityRetries: 5 } })
  );
  const proj = mk();
  fs.writeFileSync(path.join(proj, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 3 } }));
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.journal.atomicityRetries, 3, 'project overrides global');
  assert.strictEqual(cfg.journal.outputDirectory, '.claude/coalhearth', 'global key not overridden is kept');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test('walk stops at home -- a .coalhearth.json ABOVE home is ignored', () => {
  const base = mk();
  fs.writeFileSync(path.join(base, '.coalhearth.json'), JSON.stringify({ journal: { atomicityRetries: 4 } }));
  const home = path.join(base, 'h');
  fs.mkdirSync(home, { recursive: true });
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const cfg = loadConfig({ cwd: proj, home });
  assert.strictEqual(cfg.journal, undefined, 'the config above home must never be picked up');
  fs.rmSync(base, { recursive: true, force: true });
});

test('malformed JSON -> degrades to {} for that file, never throws', () => {
  const cwd = mk();
  const home = mk();
  fs.writeFileSync(path.join(cwd, '.coalhearth.json'), '{ not valid json');
  assert.doesNotThrow(() => {
    const cfg = loadConfig({ cwd, home });
    assert.deepStrictEqual(cfg, {});
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
