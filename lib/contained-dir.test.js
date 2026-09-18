// Run: node --test lib/contained-dir.test.js
// Unit tests for containedOutputDir's self-ignore write (hooks-safety.md §9 note,
// USER 2026-07-27 — the CoalWash ensureSelfIgnore port) via the EXPLICIT-root call
// shape (every case here), so the guard is proven independent of the auto-anchor path.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { containedOutputDir } = require('./contained-dir.js');

function mk() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-cd-')));
}

test('self-ignore: a fresh journal dir gets a local .gitignore containing "*"', () => {
  const root = mk();
  try {
    const dir = containedOutputDir(undefined, root);
    const gi = path.join(dir, '.gitignore');
    assert.ok(fs.existsSync(gi), 'a .gitignore is written inside the owned output dir');
    assert.strictEqual(fs.readFileSync(gi, 'utf8'), '*\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore: a second resolve of the same dir does not throw (EEXIST swallowed)', () => {
  const root = mk();
  try {
    containedOutputDir(undefined, root);
    assert.doesNotThrow(() => containedOutputDir(undefined, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// CORRECTED 2026-07-27 (main's ruling, station-3 HIGH finding): this test used to
// assert the OPPOSITE — that a custom leaf gets self-ignored. It was wrong, not the
// code: a user-chosen outputDirectory is not a directory CoalHearth exclusively owns,
// so it must never get a blanket `*` either, even a perfectly benign one. The prior
// assertion is also what the guard's fix (allowlist the physically-resolved default,
// see ensureSelfIgnore's header comment) now correctly turns red against — fixing
// THIS test to match the ruling, not patching the code to keep the old test green.
test('self-ignore: a normal custom outputDirectory leaf is NOT self-ignored (main\'s ruling)', () => {
  const root = mk();
  try {
    const dir = containedOutputDir('.claude/custom-ch', root);
    assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false, 'a custom leaf is not CH-exclusively-owned, so it does not get a blanket ignore');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// NOT the CoalWash mistake (hooks-safety.md §9 note): CoalWash's ensureSelfIgnore
// writes directly into ~/.claude itself for its global scope — a dir it does not
// exclusively own. outputDirectory is untrusted (this file's own header); these two
// prove a pathological value can never make CH do the same thing to a dir it does not
// exclusively own. RED-PROOF: drop the guard in containedOutputDir and both go red
// (a `*` .gitignore would appear at the project root / the shared .claude dir).
test('self-ignore GUARD: outputDirectory:"." (== the project root) is never self-ignored', () => {
  const root = mk();
  try {
    const dir = containedOutputDir('.', root);
    assert.strictEqual(dir, root, 'sanity: "." really does resolve to the root itself');
    assert.strictEqual(fs.existsSync(path.join(root, '.gitignore')), false, 'the whole project must never get a blanket .gitignore');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore GUARD: outputDirectory:".claude" (the dir other Coal* tools share) is never self-ignored', () => {
  const root = mk();
  try {
    const dir = containedOutputDir('.claude', root);
    assert.strictEqual(dir, path.join(root, '.claude'), 'sanity: ".claude" really does resolve to the shared dir');
    assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false, 'a dir shared with other tools must never get a blanket .gitignore');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
