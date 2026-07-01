// Run: node --test lib/state-snapshot.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildStateSnapshot } = require('./state-snapshot');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-snap-'));
}

test('no task.md / AGENTS.md / git -> all empty defaults, never throws', () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => {
    const snap = buildStateSnapshot(dir);
    assert.strictEqual(snap.status, 'in_progress');
    assert.deepStrictEqual(snap.checklist, []);
    assert.deepStrictEqual(snap.modifiedFiles, []);
    assert.strictEqual(snap.activePlan.goal, '');
    assert.deepStrictEqual(snap.activePlan.nextSteps, []);
    assert.deepStrictEqual(snap.activePlan.constraints, []);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parses goal + checklist + nextSteps from task.md', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'task.md'),
    '## Build the thing\n\n- [x] step one\n- [ ] step two\n* [ ] step three\n'
  );
  const snap = buildStateSnapshot(dir);
  assert.strictEqual(snap.activePlan.goal, 'Build the thing');
  assert.strictEqual(snap.checklist.length, 3);
  assert.strictEqual(snap.checklist[0].status, 'done');
  assert.strictEqual(snap.checklist[1].status, 'todo');
  assert.deepStrictEqual(snap.activePlan.nextSteps, ['step two', 'step three']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parses constraints from an AGENTS.md Constraints section', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'AGENTS.md'),
    '# Project\n\n## Constraints\n- never touch prod\n- fail-silent hooks\n\n## Other\n- ignored\n'
  );
  const snap = buildStateSnapshot(dir);
  assert.deepStrictEqual(snap.activePlan.constraints, ['never touch prod', 'fail-silent hooks']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git present -> modifiedFiles reflects `git status --porcelain`', (t) => {
  const dir = tmpDir();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
  } catch {
    t.skip('git not available on this machine');
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  fs.writeFileSync(path.join(dir, 'new-file.txt'), 'x');
  const snap = buildStateSnapshot(dir);
  assert.ok(snap.modifiedFiles.includes('new-file.txt'));
  fs.rmSync(dir, { recursive: true, force: true });
});
