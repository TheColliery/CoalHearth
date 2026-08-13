// Hermetic spawn test for the UserPromptSubmit hook (hooks-safety.md §7, board #94).
// Spawns the real hook as a child process with a sandboxed TEMP/HOME + cwd so real
// session state and the real ~/.claude/.coalhearth.json can never affect the test.
// Run: node --test bin/user-prompt-submit.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'user-prompt-submit.js');

function mk() {
  // realpath the tmpdir sandbox (macOS os.tmpdir() is a /var -> /private/var
  // symlink) so the hook's cwd and this test's paths agree on the same physical form.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ups-')));
}

function mkProject() {
  const dir = mk();
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const journalOf = (cwd) => path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');

function seedJournal(cwd, inFlightAgents) {
  const dir = path.dirname(journalOf(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(journalOf(cwd), JSON.stringify({
    sessionId: 's1',
    status: 'in_progress',
    checklist: [],
    modifiedFiles: [],
    inFlightAgents,
    activePlan: { goal: '', nextSteps: [], constraints: [] },
    timestamp: new Date().toISOString(),
  }), 'utf8');
}

function run(cwd, home, stdin) {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env,
    input: stdin || '',
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('no journal at all -> exit 0, silent', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('journal with no resolved (or already-surfaced) spawns -> exit 0, silent', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    seedJournal(cwd, [
      { description: 'still running', subagentType: 'x', status: 'unknown', spawnedAt: 't1' },
      { description: 'already shown', subagentType: 'x', status: 'failed', outcome: 'oops', spawnedAt: 't2', surfaced: true },
    ]);
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', "'unknown' status and already-surfaced entries never nudge");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The core of board #94's "a nudge at subagent death, not only at next session start":
// an unsurfaced resolved (completed/failed) entry emits on the sanctioned UserPromptSubmit
// channel, and is marked surfaced so the SAME entry never nudges twice.
test('an unsurfaced resolved spawn nudges once, then goes silent on the next prompt', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    seedJournal(cwd, [
      { description: 'QC gate', subagentType: 'qa', status: 'failed', outcome: 'Agent terminated early', spawnedAt: 't1' },
    ]);
    const r1 = run(cwd, home);
    assert.strictEqual(r1.status, 0);
    assert.ok(r1.stdout.includes('QC gate'), 'the description appears in the nudge');
    assert.ok(r1.stdout.includes('failed'), 'the status appears in the nudge');
    assert.ok(r1.stdout.includes('Agent terminated early'), 'the outcome text appears in the nudge');
    assert.ok(/verify liveness/i.test(r1.stdout), 'the do-not-trust-status-blind guidance is present');

    const data = JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8'));
    assert.strictEqual(data.inFlightAgents[0].surfaced, true, 'marked surfaced under the same lock as PostToolUse');

    const r2 = run(cwd, home); // a later prompt in the same session
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.stdout, '', 'the same resolution never nudges twice');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a completed (not only failed) spawn also nudges', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    seedJournal(cwd, [
      { description: 'Lint pass', subagentType: 'linter', status: 'completed', outcome: '0 errors', spawnedAt: 't1' },
    ]);
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('Lint pass'));
    assert.ok(r.stdout.includes('completed'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('multiple unsurfaced resolved spawns in one journal all nudge in one block', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    seedJournal(cwd, [
      { description: 'gate A', subagentType: 'qa', status: 'failed', outcome: 'e1', spawnedAt: 't1' },
      { description: 'gate B', subagentType: 'qa', status: 'completed', outcome: 'e2', spawnedAt: 't2' },
    ]);
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('gate A') && r.stdout.includes('gate B'), 'both entries appear in one nudge');
    const data = JSON.parse(fs.readFileSync(journalOf(cwd), 'utf8'));
    assert.ok(data.inFlightAgents.every((a) => a.surfaced), 'both marked surfaced');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('garbage stdin -> exit 0, no crash (Phoenix fail-silent)', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    seedJournal(cwd, [{ description: 'gate', subagentType: 'qa', status: 'failed', spawnedAt: 't1' }]);
    const r = run(cwd, home, 'not json at all \0\x01');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    // stdin is unused for anything but cwd-discovery, so the nudge still fires from cwd's own journal.
    assert.ok(r.stdout.includes('gate'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('corrupt journal -> exit 0 silent (quarantine path shared with ResumeEngine, no crash)', () => {
  const cwd = mkProject();
  const home = mk();
  try {
    fs.mkdirSync(path.dirname(journalOf(cwd)), { recursive: true });
    fs.writeFileSync(journalOf(cwd), '{ not json', 'utf8');
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
