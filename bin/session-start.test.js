// Hermetic spawn test for bin/session-start.js (hooks-safety.md §7: spawn the real
// file as a child process, sandbox TEMP+HOME, assert exit0 + silence-except-sanctioned
// + the state effect). Run: node --test bin/session-start.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'session-start.js');
const PTU = path.join(__dirname, 'post-tool-use.js'); // the other half of the two-session flow (ROOT 2/H3)

function sandbox() {
  // realpath the tmpdir sandboxes: on macOS os.tmpdir() is /var -> /private/var
  // (a symlink), and a spawned hook's process.cwd() returns the resolved
  // /private/var form. Resolving here keeps the paths we pass and assert against
  // in the SAME physical form the hook sees, so a lexical path.relative in the
  // hook (modifiedFiles) yields the clean relative path the assertions expect
  // (ROOT2/H3). No-op off macOS; matches every other sandbox helper in the repo.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ss-home-')));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ss-cwd-')));
  return { home, cwd };
}

function runHook(cwd, home) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    // CLAUDE_CONFIG_DIR emptied: the config loader honors it, so a real machine value
    // would point the "global" config outside the sandbox home (hooks-safety §7).
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
  });
}

function runPTU(cwd, home, stdin) {
  return spawnSync(process.execPath, [PTU], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    input: stdin || '',
    encoding: 'utf8',
  });
}

const journalOf = (cwd) => path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');

function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// A fresh sandbox home makes the self-update check "due" on the first boot; the
// strict-silence tests here are about the JOURNAL path, so they mute it (the update
// path has its own hermetic cases in scripts/lib/hooks.test.mjs, cases 12-14).
function muteUpdate(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalhearth.json'), '{"update":{"updateMode":"off"}}', 'utf8');
}

test('no journal present: exits 0, silent, prints nothing', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  const r = runHook(cwd, home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  cleanup(home, cwd);
});

test('in_progress journal: exits 0, prints the recovery block, marks resumed', () => {
  const { home, cwd } = sandbox();
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  const journalPath = path.join(outDir, 'session_handoff.json');
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      sessionId: 'abc-123',
      timestamp: '2026-07-01T00:00:00.000Z',
      status: 'in_progress',
      checklist: [{ task: 'do the thing', status: 'doing' }],
      modifiedFiles: ['lib/foo.js'],
      activePlan: { goal: 'Ship the feature', nextSteps: ['write tests'], constraints: [] },
    }),
    'utf8'
  );

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(r.stdout.includes('CoalHearth Warm-Resume Recovery'));
  assert.ok(r.stdout.includes('Ship the feature'));

  const after = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(after.status, 'resumed');

  cleanup(home, cwd);
});

// Regression (CoalBoard nasa audit 2026-07-09 L6): a read-only journal (stand-in for a
// read-only filesystem) makes the mark-resumed write fail. Previously this was swallowed
// silently, so the SAME recovery block would re-inject every subsequent boot forever with
// no explanation. The hook must now say so in the block itself, and stay fail-silent
// (exit 0, no stderr) either way.
//
// CROSS-PLATFORM (CI-red-on-POSIX fix, v2.0.0→v2.0.1): markResumed now writes ATOMICALLY
// (per-pid temp + rename). chmod-ing only the journal FILE 0o444 does NOT simulate a
// read-only fs on POSIX — rename(2) replaces a destination needing only DIRECTORY write, so
// the temp renames over the 0o444 file and the write SUCCEEDS (note never fires; the test was
// green on Windows, where MoveFileEx over a read-only file fails, and red on macOS/Linux).
// A TRUE read-only fs makes the whole DIR unwritable: 0o555 fails the temp CREATE on POSIX,
// and the 0o444 file fails MoveFileEx on Windows — so the honesty path is exercised on every
// platform, no skip. Perms restored in finally (a 0o555 dir blocks unlinking its children on POSIX).
test('read-only journal (mark-resumed write fails): still exits 0, still prints recovery, says it may repeat', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  const journalPath = path.join(outDir, 'session_handoff.json');
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      sessionId: 'abc-123', timestamp: '2026-07-01T00:00:00.000Z', status: 'in_progress',
      checklist: [], modifiedFiles: [], activePlan: { goal: 'Ship the feature', nextSteps: [], constraints: [] },
    }),
    'utf8'
  );
  fs.chmodSync(journalPath, 0o444); // Windows: MoveFileEx over a read-only destination fails
  fs.chmodSync(outDir, 0o555);      // POSIX: an unwritable dir fails the atomic temp-create

  try {
    const r = runHook(cwd, home);

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    assert.ok(r.stdout.includes('CoalHearth Warm-Resume Recovery'), 'recovery block still injected');
    assert.ok(r.stdout.toLowerCase().includes('may repeat'), 'honest note that the block may repeat');

    const after = JSON.parse(fs.readFileSync(journalPath, 'utf8')); // 0o444 file + r-x dir are still readable
    assert.strictEqual(after.status, 'in_progress', 'write failed -> status could not be marked resumed');
  } finally {
    fs.chmodSync(outDir, 0o755); // re-writable so the sandbox can be removed on POSIX
    try { fs.chmodSync(journalPath, 0o644); } catch {}
    cleanup(home, cwd);
  }
});

// Regression (audit 2026-07-02 L7): recovery.autoInjectPrompt:false must suppress the
// recovery-block injection while STILL detecting + marking the journal resumed (so it
// doesn't re-detect forever). Previously the flag was inert (always injected).
test('autoInjectPrompt:false: exits 0, suppresses the recovery block, still marks resumed', () => {
  const { home, cwd } = sandbox();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.coalhearth.json'),
    '{"update":{"updateMode":"off"},"recovery":{"autoInjectPrompt":false}}',
    'utf8'
  );
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  const journalPath = path.join(outDir, 'session_handoff.json');
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      sessionId: 'abc-123', timestamp: '2026-07-01T00:00:00.000Z', status: 'in_progress',
      checklist: [], modifiedFiles: [], activePlan: { goal: 'Ship the feature', nextSteps: [], constraints: [] },
    }),
    'utf8'
  );

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout, '', 'no recovery block injected when autoInjectPrompt:false');
  const after = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(after.status, 'resumed', 'journal still marked resumed (no re-detect loop)');

  cleanup(home, cwd);
});

test('completed journal: exits 0, silent, does not touch the file', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  const journalPath = path.join(outDir, 'session_handoff.json');
  fs.writeFileSync(journalPath, JSON.stringify({ status: 'completed' }), 'utf8');

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const after = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(after.status, 'completed'); // untouched

  cleanup(home, cwd);
});

test('corrupt journal: quarantines, boots clean, exits 0 silent', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  const journalPath = path.join(outDir, 'session_handoff.json');
  fs.writeFileSync(journalPath, '{ not json', 'utf8');

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(fs.existsSync(journalPath), false);
  assert.strictEqual(fs.existsSync(path.join(outDir, 'session_handoff.corrupt.json')), true);

  cleanup(home, cwd);
});

test('never walks above HOME for project config (sandbox isolation holds)', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  // A .coalhearth.json placed ABOVE home must never be read by a cwd nested under home.
  const aboveHome = path.dirname(home);
  const outsideMarker = path.join(aboveHome, `.coalhearth-outside-${Date.now()}.json`);
  const nestedCwd = fs.mkdtempSync(path.join(home, 'nested-'));
  try {
    const r = runHook(nestedCwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(outsideMarker, { force: true });
    cleanup(home, cwd);
  }
});

// ROOT 2 / H3 (two-terminal total loss — crash-test: "deterministic total loss, no timing").
// Session A accumulates files; a SECOND session B boots (SessionStart) in the same workspace
// and flips the shared journal to 'resumed'. Before the fix, A's next tool call saw
// status != 'in_progress', rebuilt from EMPTY, and DISCARDED all of A's accumulated files.
// Now A's step keys "same session" on its OWN id (which the boot preserved), so A keeps its
// journal. RED-PROOF: revert recordStep's sameSession to `prior.status === 'in_progress'`
// only, and A's earlier files vanish after B boots (goes red).
test('ROOT2/H3: a second session booting does not make the first lose its accumulated journal', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  try {
    for (let i = 0; i < 3; i++) {
      runPTU(cwd, home, JSON.stringify({ session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: path.join(cwd, `a${i}.js`) } }));
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8')).modifiedFiles, ['a0.js', 'a1.js', 'a2.js']);

    // Session B boots in the same workspace: its SessionStart marks the shared journal resumed.
    const b = runHook(cwd, home);
    assert.strictEqual(b.status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8')).status, 'resumed');

    // Session A's NEXT tool call must still recognise its own journal and accumulate, not discard.
    runPTU(cwd, home, JSON.stringify({ session_id: 'sess-A', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a3.js') } }));
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8')).modifiedFiles,
      ['a0.js', 'a1.js', 'a2.js', 'a3.js'],
      'A kept its accumulated files after B booted (no cross-session total loss)'
    );
  } finally {
    cleanup(home, cwd);
  }
});

// ROOT 3 / H4 (a wrong-typed field crashes the prompt build AFTER mark-resumed). A journal
// whose array fields are the wrong type (checklist a STRING, modifiedFiles an OBJECT,
// nextSteps a STRING) must NOT throw in generateHandoffPrompt — a throw is swallowed
// fail-silent, and before the reorder the journal was ALREADY marked 'resumed' so the
// recovery block was lost forever (permanently unrecoverable). Now the build is
// array-coercion-safe AND runs before the mark. RED-PROOF: revert asArray() to `|| []` in
// lib/resume-engine.js and the block disappears (goes red).
test('ROOT3/H4: a wrong-typed journal field still renders the recovery block (no throw, still recoverable)', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  const outDir = path.join(cwd, '.claude', 'coalhearth');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(journalOf(cwd), JSON.stringify({
    sessionId: 'x', status: 'in_progress',
    checklist: 'not-an-array',        // wrong type: strings/objects have no .map/.filter
    modifiedFiles: { nope: true },    // wrong type
    activePlan: { goal: 'Ship it', nextSteps: 'also-not-an-array', constraints: [] },
  }));

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(r.stdout.includes('CoalHearth Warm-Resume Recovery'), 'the recovery block renders despite wrong-typed fields');
  assert.ok(r.stdout.includes('Ship it'), 'the goal still shows');
  assert.strictEqual(JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8')).status, 'resumed', 'marked resumed (built first, so a throw could not orphan it)');
  cleanup(home, cwd);
});

// ROOT 3 / H5 (silent no-op when the journal dir is blocked). A FILE occupying
// .claude/coalhearth makes containedOutputDir return null => save()/detectAbortedSession
// no-op FOREVER with ZERO signal, so the user believes they are protected. SessionStart must
// now say so on the sanctioned channel. RED-PROOF: remove the `if (!engine.outputDir)` note
// in bin/session-start.js and this goes red.
test('ROOT3/H5: a file blocking the journal dir produces a non-silent signal (not a silent no-op)', () => {
  const { home, cwd } = sandbox();
  muteUpdate(home);
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'coalhearth'), 'blocker'); // a FILE where the journal dir must be

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.match(r.stdout, /\[CoalHearth\][^\n]*journal directory/i, 'a one-line signal that warm-resume protection is OFF');
  cleanup(home, cwd);
});
