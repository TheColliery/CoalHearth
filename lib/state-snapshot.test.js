// Run: node --test lib/state-snapshot.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildStateSnapshot } = require('./state-snapshot');

function tmpDir() {
  // realpath the sandbox: on macOS os.tmpdir() (/var) is a symlink to /private/var,
  // and buildStateSnapshot's lexical path.relative needs cwd and the touched path
  // in the SAME physical form for the relativized assertions to hold. (Windows/
  // Linux tmp has no such symlink, so realpath is a no-op there.)
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-snap-')));
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

// Regression (audit 2026-07-02 HIGH): `\Z` is a literal Z in JS regex, not an
// end-of-input anchor. When Constraints/Working Rules is the LAST section of
// AGENTS.md (a common shape) and no literal "Z" follows, the old lazy body found no
// stop point and the WHOLE match silently failed -> constraints dropped -> the
// resumed agent lost its guardrails. This fixture has NO trailing `##` and NO "Z";
// it FAILS (constraints [] ) on literal-Z and PASSES with the `(?![\s\S])` anchor.
test('parses constraints when the Constraints section is LAST (no trailing ## / no literal Z)', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'AGENTS.md'),
    '# Project\n\n## Constraints\n- never touch prod\n- fail-silent hooks\n'
  );
  const snap = buildStateSnapshot(dir);
  assert.deepStrictEqual(snap.activePlan.constraints, ['never touch prod', 'fail-silent hooks']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// modifiedFiles is now accumulated from what the hook OBSERVES (prior journal list
// + the current tool call's file path) — pure fs, NO git spawn (Phoenix #5,
// audit 2026-07-02 MED). These cover the merge: accumulate, dedupe, relativize.
test('modifiedFiles accumulates prior + touched file, relativized under cwd', () => {
  const dir = tmpDir();
  const snap = buildStateSnapshot(dir, {
    priorModifiedFiles: ['lib/a.js'],
    touchedFile: path.join(dir, 'src', 'b.js'), // absolute, inside cwd -> relative
  });
  assert.deepStrictEqual(snap.modifiedFiles, ['lib/a.js', path.join('src', 'b.js')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modifiedFiles dedupes a re-touched file and keeps an outside-cwd path absolute', () => {
  const dir = tmpDir();
  const again = buildStateSnapshot(dir, {
    priorModifiedFiles: [path.join('src', 'b.js')],
    touchedFile: path.join(dir, 'src', 'b.js'), // same file re-touched -> no dup
  });
  assert.deepStrictEqual(again.modifiedFiles, [path.join('src', 'b.js')]);

  const outside = path.join(os.tmpdir(), 'elsewhere', 'c.js'); // outside cwd -> kept absolute
  const snap = buildStateSnapshot(dir, { priorModifiedFiles: [], touchedFile: outside });
  assert.deepStrictEqual(snap.modifiedFiles, [outside]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modifiedFiles degrades safely: no opts / junk prior -> empty or filtered, never throws', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(buildStateSnapshot(dir).modifiedFiles, []);
  const snap = buildStateSnapshot(dir, { priorModifiedFiles: ['ok.js', 42, null, ''], touchedFile: undefined });
  assert.deepStrictEqual(snap.modifiedFiles, ['ok.js'], 'non-string prior entries filtered');
  fs.rmSync(dir, { recursive: true, force: true });
});
