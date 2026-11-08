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
const { spawnSync } = require('node:child_process');
const { REPO_READ_FLAGS } = require('./repo-fs.js');
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

// r29cw BUILD 2: a .gitignore a cloned repository planted in the default journal folder must not stay. The
// tool's own `*\n` file is the only accepted content; anything else (a file with other bytes, a link, a
// directory at the name) is replaced, or the default folder is refused (null) when it cannot be replaced.
// Every case here plants the file first, then runs the one call that builds the journal folder.
function journalFolder(root) {
  const dir = path.join(root, '.claude', 'coalhearth');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('self-ignore: a planted .gitignore holding "!*" is replaced with the tool\'s "*" (a regular file)', () => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    fs.writeFileSync(path.join(dir, '.gitignore'), '!*\n', 'utf8');
    const out = containedOutputDir(undefined, root);
    assert.strictEqual(out, dir, 'the default folder is still used');
    const gi = path.join(dir, '.gitignore');
    const bytes = fs.readFileSync(gi, 'utf8');
    assert.ok(fs.lstatSync(gi).isFile(), 'the .gitignore is a regular file');
    assert.strictEqual(bytes, '*\n', 'the planted "!*" is gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore: a planted EMPTY .gitignore is replaced with the tool\'s "*"', () => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    fs.writeFileSync(path.join(dir, '.gitignore'), '', 'utf8');
    assert.strictEqual(containedOutputDir(undefined, root), dir);
    const gi = path.join(dir, '.gitignore');
    const bytes = fs.readFileSync(gi, 'utf8');
    assert.ok(fs.lstatSync(gi).isFile(), 'the .gitignore is a regular file');
    assert.strictEqual(bytes, '*\n', 'the planted empty file is replaced');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore: a LINK at .gitignore is replaced by a regular "*" file; the link target is unchanged', (t) => {
  const root = mk();
  const outside = mk();
  try {
    const dir = journalFolder(root);
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'OUTSIDE-BYTES', 'utf8');
    const gi = path.join(dir, '.gitignore');
    try {
      fs.symlinkSync(target, gi, 'file');
    } catch {
      t.skip('a file symlink needs a privilege on this volume (probe: symlink refused) — the link leg cannot run here');
      return;
    }
    assert.strictEqual(containedOutputDir(undefined, root), dir);
    const bytes = fs.readFileSync(gi, 'utf8');
    const targetBytes = fs.readFileSync(target, 'utf8');
    assert.ok(fs.lstatSync(gi).isFile() && !fs.lstatSync(gi).isSymbolicLink(), 'the link is replaced by a regular file');
    assert.strictEqual(bytes, '*\n');
    assert.strictEqual(targetBytes, 'OUTSIDE-BYTES', 'the link target is not written through');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('self-ignore: a DIRECTORY at .gitignore refuses the default folder (containedOutputDir returns null)', () => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    fs.mkdirSync(path.join(dir, '.gitignore'));
    assert.strictEqual(containedOutputDir(undefined, root), null, 'a directory at the .gitignore name is not replaced: the journal is off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A FIFO at the name: an open for read WITHOUT O_NONBLOCK waits for a writer, so the hook would hang with no
// writer. The open must never wait. Rename replaces a FIFO on POSIX, so the rule replaces it, as it replaces a
// planted `!*`: the folder stays usable and the name ends as the tool's own file. The child runs with a timeout,
// so a hang fails this leg instead of the suite. Windows has no FIFO at a file name: visible skip there.
test('self-ignore: a FIFO at .gitignore never blocks the open, and is replaced by the tool\'s "*" file (POSIX)', (t) => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    const gi = path.join(dir, '.gitignore');
    const made = spawnSync('mkfifo', [gi], { timeout: 5000 });
    let madeFifo = false;
    try { madeFifo = fs.lstatSync(gi).isFIFO(); } catch { /* no entry at the name: mkfifo made nothing here */ }
    if (made.error || made.status !== 0 || !madeFifo) {
      t.skip('no FIFO can be made here (mkfifo missing, or no FIFO at a file name on this platform): the FIFO leg cannot run');
      return;
    }
    const script = `const { containedOutputDir } = require(${JSON.stringify(path.join(__dirname, 'contained-dir.js'))});`
      + `const out = containedOutputDir(undefined, ${JSON.stringify(root)});`
      + `process.stdout.write(out === null ? 'NULL' : 'OK');`;
    const r = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
    assert.ifError(r.error, 'the child returned: a blocked open is killed at the timeout');
    assert.strictEqual(r.signal, null);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, 'OK', 'the default folder is still used');
    // The bytes are read before the kind is checked, through a descriptor opened with the house read flags (O_NONBLOCK): the read cannot block,
    // so a FIFO still in place fails with a named error, never a hang. This read also runs only after the child said OK.
    const fd = fs.openSync(gi, REPO_READ_FLAGS);
    let bytes;
    try { bytes = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    assert.ok(fs.lstatSync(gi).isFile(), 'the FIFO is replaced by a regular file');
    assert.strictEqual(bytes, '*\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The tool cannot create its own .gitignore (a read-only folder): mocked on every platform, because a read-only
// directory does not block file creation on Windows. Only the tool's temp name fails; the planted names are written
// before the mock and are not affected.
function failSelfIgnoreCreate(t) {
  const realWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (path.basename(String(file)).startsWith('.gitignore.')) {
      const err = new Error(`EACCES: permission denied, open '${file}'`);
      err.code = 'EACCES';
      throw err;
    }
    return realWrite(file, ...rest);
  });
}

test('self-ignore: an ABSENT .gitignore that cannot be created keeps the journal folder usable (best-effort, as before 83a970b)', (t) => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    failSelfIgnoreCreate(t);
    assert.strictEqual(containedOutputDir(undefined, root), dir, 'the default folder is still used');
    assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), 'no .gitignore was planted and none was created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore: a PLANTED .gitignore that cannot be replaced still refuses the default folder (control)', (t) => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    fs.writeFileSync(path.join(dir, '.gitignore'), '!*\n', 'utf8');
    failSelfIgnoreCreate(t);
    assert.strictEqual(containedOutputDir(undefined, root), null, 'a planted name that cannot be replaced: the journal is off');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '!*\n', 'the planted file is left as it was');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('self-ignore control: the tool\'s own "*" file is left alone (its mtime is unchanged on the next resolve)', () => {
  const root = mk();
  try {
    const dir = journalFolder(root);
    const gi = path.join(dir, '.gitignore');
    fs.writeFileSync(gi, '*\n', 'utf8');
    const past = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(gi, past, past);
    assert.strictEqual(containedOutputDir(undefined, root), dir);
    assert.strictEqual(fs.statSync(gi).mtimeMs, past.getTime(), 'a correct .gitignore is not rewritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
