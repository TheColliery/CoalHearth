import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDist, checkDist } from './build-plugin.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-dist-test-'));
}

test('buildDist + checkDist round-trip clean against the real source', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  assert.deepEqual(checkDist(distRoot), []);
  fs.rmSync(distRoot, { recursive: true, force: true });
});

test('checkDist flags a stale file', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  fs.writeFileSync(path.join(distRoot, '.claude-plugin', 'plugin.json'), '{}');
  const drift = checkDist(distRoot);
  assert.ok(drift.some((d) => d.includes('stale')));
  fs.rmSync(distRoot, { recursive: true, force: true });
});

test('checkDist flags an orphan top-level entry', () => {
  const distRoot = mkTmp();
  buildDist(distRoot);
  fs.mkdirSync(path.join(distRoot, 'scripts'));
  const drift = checkDist(distRoot);
  assert.ok(drift.some((d) => d.includes('orphan top-level')));
  fs.rmSync(distRoot, { recursive: true, force: true });
});
