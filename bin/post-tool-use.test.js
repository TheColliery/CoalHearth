// Hermetic spawn test for the PostToolUse hook (hooks-safety.md §7).
// Spawns the real hook as a child process with a sandboxed TEMP/HOME + cwd so real
// session state and the real ~/.claude/.coalhearth.json can never affect the test.
// Run: node --test bin/post-tool-use.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'post-tool-use.js');

function mk() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coalhearth-ptu-'));
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

test('happy path: writes session_handoff.json, exit 0, no stderr', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
    const journalPath = path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json');
    assert.ok(fs.existsSync(journalPath), 'journal must be written on the happy path');
    const data = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.strictEqual(data.status, 'in_progress');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('task.md checklist is parsed into the journal', () => {
  const cwd = mk();
  const home = mk();
  try {
    fs.writeFileSync(
      path.join(cwd, 'task.md'),
      '# Ship the widget\n\n- [x] design\n- [ ] implement\n- [ ] test\n'
    );
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    const data = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')
    );
    assert.strictEqual(data.activePlan.goal, 'Ship the widget');
    assert.strictEqual(data.checklist.length, 3);
    assert.deepStrictEqual(data.activePlan.nextSteps, ['implement', 'test']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no task.md / no git -> still succeeds with empty defaults (no-external-assumption)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    const data = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'coalhearth', 'session_handoff.json'), 'utf8')
    );
    assert.deepStrictEqual(data.modifiedFiles, []);
    assert.deepStrictEqual(data.checklist, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('near-limit config -> advisory nudge on stdout (best-effort, non-blocking)', () => {
  const cwd = mk();
  const home = mk();
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.coalhearth.json'),
      JSON.stringify({ budgets: { maxTurns: 1, warningTurnThreshold: 5 } })
    );
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /\[CoalHearth\]/);
    assert.match(r.stdout, /advisory/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('garbage stdin -> exit 0, no crash (Phoenix fail-silent)', () => {
  const cwd = mk();
  const home = mk();
  try {
    const r = run(cwd, home, 'not json at all \0\x01');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unwritable outputDir (blocked by a file) -> fail-silent, exit 0', () => {
  const cwd = mk();
  const home = mk();
  try {
    // Put a FILE where the journal dir would be created -> mkdirSync must fail inside
    // HandoffJournal's own try/catch, and the hook must still exit 0 silently.
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'coalhearth'), 'blocker');
    const r = run(cwd, home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
