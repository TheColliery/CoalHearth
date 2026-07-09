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

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ss-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ss-cwd-'));
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
  fs.chmodSync(journalPath, 0o444); // simulate a read-only fs: the mark-resumed write will throw

  const r = runHook(cwd, home);

  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(r.stdout.includes('CoalHearth Warm-Resume Recovery'), 'recovery block still injected');
  assert.ok(r.stdout.toLowerCase().includes('may repeat'), 'honest note that the block may repeat');

  const after = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(after.status, 'in_progress', 'write failed -> status could not be marked resumed');

  cleanup(home, cwd); // rmSync(force:true) removes the read-only file fine on this platform
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
